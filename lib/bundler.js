// Bundle contents:
// main.js [run to start the server]
// /static [served by node for now]
// /static_cacheable [cache-forever files, served by node for now]
// /server
//   server.js, db.js, .... [contents of app/server]
//   node_modules [for now, contents of (meteor_root)/lib/node_modules]
// /app.html
// /app [user code]
// /app.json: [data for server.js]
//  - load [list of files to load, relative to root, presumably under /app]
//  - manifest [list of resources in load order, each consists of an object]:
//     {
//       "path": relative path of file in the bundle, normalized to use forward slashes
//       "where": "client"  [could also be "server" in future]
//       "type": "js", "css", or "static"
//       "cacheable": (client) boolean, is it safe to ask the browser to cache this file
//       "url": (client) relative url to download the resource, includes cache
//              busting param if used
//       "size": size in bytes
//       "hash": sha1 hash of the contents
//     }
// /dependencies.json: files to monitor for changes in development mode
//  - extensions [list of extensions registered for user code, with dots]
//  - packages [map from package name to list of paths relative to the package]
//  - core [paths relative to 'app' in meteor tree]
//  - app [paths relative to top of app tree]
//  - exclude [list of regexps for files to ignore (everywhere)]
//  (for 'core' and 'apps', if a directory is given, you should
//  monitor everything in the subtree under it minus the stuff that
//  matches exclude, and if it doesn't exist yet, you should watch for
//  it to appear)
//
// The application launcher is expected to execute /main.js with node, setting
// various environment variables (such as PORT and MONGO_URL). The enclosed node
// application is expected to do the rest, including serving /static.

var path = require('path');
var files = require(path.join(__dirname, 'files.js'));
var packages = require(path.join(__dirname, 'packages.js'));
var warehouse = require(path.join(__dirname, 'warehouse.js'));
var crypto = require('crypto');
var fs = require('fs');
var uglify = require('uglify-js');
var cleanCSS = require('clean-css');
var _ = require('underscore');
var project = require(path.join(__dirname, 'project.js'));

// files to ignore when bundling. node has no globs, so use regexps
var ignore_files = [
    /~$/, /^\.#/, /^#.*#$/,
    /^\.DS_Store$/, /^ehthumbs\.db$/, /^Icon.$/, /^Thumbs\.db$/,
    /^\.meteor$/, /* avoids scanning N^2 files when bundling all packages */
    /^\.git$/ /* often has too many files to watch */
];

///////////////////////////////////////////////////////////////////////////////
// PackageBundlingInfo
///////////////////////////////////////////////////////////////////////////////

// Represents the occurrence of a package in a bundle. Includes data
// relevant to the process of bundling this package, distinct from the
// package data itself.
var PackageBundlingInfo = function (pkg, bundle) {
  var self = this;
  self.pkg = pkg;
  self.bundle = bundle;

  // list of places we've already been used. map from a 'canonicalized
  // where' to true. 'canonicalized where' is the JSONification of a
  // sorted array with zero or more elements drawn from the set
  // 'client', 'server', with each element unique
  // XXX this is a mess, refactor
  self.where = {};

  // other packages we've used (with any 'where') -- map from id to package
  self.using = {};

  // map from where (client, server) to a source file name (relative
  // to the package) to true
  self.files = {client: {}, server: {}};

  // files we depend on -- map from rel_path to true
  self.dependencies = {};
  if (pkg.name)
    self.dependencies['package.js'] = true;

  // the API available from on_use / on_test handlers
  self.api = {
    // Called when this package wants to make another package be
    // used. Can also take literal package objects, if you have
    // anonymous packages you want to use (eg, app packages)
    use: function (names, where) {
      if (!(names instanceof Array))
        names = names ? [names] : [];

      _.each(names, function (name) {
        var pkg = packages.get(self.bundle.releaseManifest, name);
        if (!pkg)
          throw new Error("Package not found: " + name);
        self.bundle.use(pkg, where, self);
      });
    },

    add_files: function (paths, where) {
      if (!(paths instanceof Array))
        paths = paths ? [paths] : [];
      if (!(where instanceof Array))
        where = where ? [where] : [];

      _.each(where, function (w) {
        _.each(paths, function (rel_path) {
          self.add_file(rel_path, w);
        });
      });
    },

    // Return a list of all of the extension that indicate source files
    // inside this package, INCLUDING leading dots.
    registered_extensions: function () {
      var ret = _.keys(self.pkg.extensions);

      for (var id in self.using) {
        var other_inst = self.using[id];
        ret = _.union(ret, _.keys(other_inst.pkg.extensions));
      }

      return _.map(ret, function (x) {return "." + x;});
    },

    // Report an error. It should be a single human-readable
    // string. If any errors are reported, the bundling is considered
    // to have failed.
    error: function (message) {
      self.bundle.errors.push(message);
    }
  };

  if (pkg.name !== "meteor")
    self.api.use("meteor");
};

_.extend(PackageBundlingInfo.prototype, {
  // Find the function that should be used to handle a source file
  // found in this package. We'll use handlers that are defined in
  // this package and in its immediate dependencies. ('extension'
  // should be the extension of the file without a leading dot.)
  get_source_handler: function (extension) {
    var self = this;
    var candidates = [];

    if (extension in self.pkg.extensions)
      candidates.push(self.pkg.extensions[extension]);

    for (var id in self.using) {
      var other_inst = self.using[id];
      var other_pkg = other_inst.pkg;
      if (extension in other_pkg.extensions)
        candidates.push(other_pkg.extensions[extension]);
    }

    // XXX do something more graceful than printing a stack trace and
    // exiting!! we have higher standards than that!

    if (!candidates.length)
      return null;

    if (candidates.length > 1)
      // XXX improve error message (eg, name the packages involved)
      // and make it clear that it's not a global conflict, but just
      // among this package's dependencies
      throw new Error("Conflict: two packages are both trying " +
                      "to handle ." + extension);

    return candidates[0];
  },

  add_file: function (rel_path, where) {
    var self = this;

    if (self.files[where][rel_path])
      return;
    self.files[where][rel_path] = true;

    var ext = path.extname(rel_path).substr(1);
    var handler = self.get_source_handler(ext);
    if (!handler) {
      // If we don't have an extension handler, serve this file
      // as a static resource.
      self.bundle.api.add_resource({
        type: "static",
        path: path.join(self.pkg.serve_root, rel_path),
        data: fs.readFileSync(path.join(self.pkg.source_root, rel_path)),
        where: where
      });
      return;
    }

    handler(self.bundle.api,
            path.join(self.pkg.source_root, rel_path),
            path.join(self.pkg.serve_root, rel_path),
            where);

    self.dependencies[rel_path] = true;
  }
});

///////////////////////////////////////////////////////////////////////////////
// Bundle
///////////////////////////////////////////////////////////////////////////////

var Bundle = function () {
  var self = this;

  // Packages being used. Map from a package id to a PackageBundlingInfo.
  self.packageBundlingInfo = {};

  // Packages that have had tests included. Map from package id to instance
  self.tests_included = {};

  // meteor release manifest
  self.releaseManifest = null;

  // map from environment, to list of filenames
  self.js = {client: [], server: []};

  // list of filenames
  self.css = [];

  // Map from environment, to path name (server relative), to contents
  // of file as buffer.
  self.files = {client: {}, client_cacheable: {}, server: {}};

  // See description of manifest at the top
  self.manifest = [];

  // these directories are copied (cp -r) or symlinked into the
  // bundle. maps target path (server relative) to source directory on
  // disk
  self.nodeModulesDirs = {};

  // list of segments of additional HTML for <head>/<body>
  self.head = [];
  self.body = [];

  // list of errors encountered while bundling. array of string.
  self.errors = [];

  // the API available from register_extension handlers
  self.api = {
    /**
     * This is the ultimate low-level API to add data to the bundle.
     *
     * type: "js", "css", "head", "body", "static"
     *
     * where: an environment, or a list of one or more environments
     * ("client", "server", "tests") -- for non-JS resources, the only
     * legal environment is "client"
     *
     * path: the (absolute) path at which the file will be
     * served. ignored in the case of "head" and "body".
     *
     * source_file: the absolute path to read the data from. if path
     * is set, will default based on that. overridden by data.
     *
     * data: the data to send. overrides source_file if present. you
     * must still set path (except for "head" and "body".)
     */
    add_resource: function (options) {
      var source_file = options.source_file || options.path;

      var data = options.data;
      if (options.data) {
        var data = options.data;
        if (!(data instanceof Buffer)) {
          if (!(typeof data === "string"))
            throw new Error("Bad type for data");
          data = new Buffer(data, 'utf8');
        }
      } else {
        if (!source_file)
          throw new Error("Need either source_file or data");
        var data = fs.readFileSync(source_file);
      }

      var where = options.where;
      if (typeof where === "string")
        where = [where];
      if (!where)
        throw new Error("Must specify where");

      _.each(where, function (w) {
        if (options.type === "js") {
          if (!options.path)
            throw new Error("Must specify path");

          if (w === "client" || w === "server") {
            self.files[w][options.path] = data;
            self.js[w].push(options.path);
          } else {
            throw new Error("Invalid environment");
          }
        } else if (options.type === "css") {
          if (w !== "client")
            // XXX might be nice to throw an error here, but then we'd
            // have to make it so that packages.js ignores css files
            // that appear in the server directories in an app tree
            return;
          if (!options.path)
            throw new Error("Must specify path");
          self.files.client[options.path] = data;
          self.css.push(options.path);
        } else if (options.type === "head" || options.type === "body") {
          if (w !== "client")
            throw new Error("HTML segments can only go to the client");
          self[options.type].push(data);
        } else if (options.type === "static") {
          self.files[w][options.path] = data;
        } else {
          throw new Error("Unknown type " + options.type);
        }
      });
    },

    // Report an error. It should be a single human-readable
    // string. If any errors are reported, the bundling is considered
    // to have failed.
    error: function (message) {
      self.errors.push(message);
    }
  };
};

_.extend(Bundle.prototype, {
  _get_bundling_info_for_package: function (pkg) {
    var self = this;

    var bundlingInfo = self.packageBundlingInfo[pkg.id];
    if (!bundlingInfo) {
      bundlingInfo = new PackageBundlingInfo(pkg, self);
      self.packageBundlingInfo[pkg.id] = bundlingInfo;
    }

    return bundlingInfo;
  },

  _hash: function (contents) {
    var hash = crypto.createHash('sha1');
    hash.update(contents);
    return hash.digest('hex');
  },

  // Call to add a package to this bundle
  // if 'where' is given, it's an array of "client" and/or "server"
  // if 'from' is given, it's the PackageBundlingInfo that's doing the
  // using, or it can be undefined for top level
  use: function (pkg, where, from) {
    var self = this;
    var inst = self._get_bundling_info_for_package(pkg);

    if (from)
      from.using[pkg.id] = inst;

    // get 'canonicalized where'
    var canon_where = where;
    if (!canon_where)
      canon_where = [];
    if (!(canon_where instanceof Array))
      canon_where = [canon_where];
    else
      canon_where = _.clone(canon_where);
    canon_where.sort();
    canon_where = JSON.stringify(canon_where);

    if (inst.where[canon_where])
      return; // already used in this environment
    inst.where[canon_where] = true;

    // XXX detect circular dependencies and print an error. (not sure
    // what the current code will do)

    if (pkg.npmDependencies) {
      pkg.installNpmDependencies();
      self.bundleNodeModules(pkg);
    }

    if (pkg.on_use_handler)
      pkg.on_use_handler(inst.api, where);
  },

  includeTests: function (packageOrPackageName) {
    var self = this;
    // 'packages.get' is a noop if 'packageOrPackageName' is a Package object.
    var pkg = packages.get(self.releaseManifest, packageOrPackageName);
    if (!pkg) {
      console.error("Can't find package " + packageOrPackageName);
      process.exit(1);
    }
    if (self.tests_included[pkg.id])
      return;
    self.tests_included[pkg.id] = true;

    var inst = self._get_bundling_info_for_package(pkg);

    // XXX we might want to support npm modules that are only used in
    // tests. one example is stream-buffers as used in the email
    // package
    if (pkg.npmDependencies) {
      pkg.installNpmDependencies();
      self.bundleNodeModules(pkg);
    }

    if (inst.pkg.on_test_handler)
      inst.pkg.on_test_handler(inst.api);
  },

  // map a package's generated node_modules directory to the package
  // directory within the bundle
  bundleNodeModules: function (pkg) {
    var nodeModulesPath = path.join(pkg.npmDir(), 'node_modules');
    // use '/' rather than path.join since this is part of a url
    var relNodeModulesPath = ['packages', pkg.name, 'node_modules'].join('/');
    this.nodeModulesDirs[relNodeModulesPath] = nodeModulesPath;
  },

  // Minify the bundle
  minify: function () {
    var self = this;

    var addFile = function (type, finalCode) {
      var contents = new Buffer(finalCode);
      var hash = self._hash(contents);
      var name = '/' + hash + '.' + type;
      self.files.client_cacheable[name] = contents;
      self.manifest.push({
        path: 'static_cacheable' + name,
        where: 'client',
        type: type,
        cacheable: true,
        url: name,
        size: contents.length,
        hash: hash
      });
    };

    /// Javascript
    var codeParts = [];
    _.each(self.js.client, function (js_path) {
      codeParts.push(self.files.client[js_path].toString('utf8'));

      delete self.files.client[js_path];
    });
    self.js.client = [];

    var combinedCode = codeParts.join('\n;\n');
    var finalCode = uglify.minify(
      combinedCode, {fromString: true, compress: {drop_debugger: false}}).code;

    addFile('js', finalCode);

    /// CSS
    var css_concat = "";
    _.each(self.css, function (css_path) {
      var css_data = self.files.client[css_path];
      css_concat = css_concat + "\n" +  css_data.toString('utf8');

      delete self.files.client[css_path];
    });
    self.css = [];

    var final_css = cleanCSS.process(css_concat);

    addFile('css', final_css);
  },

  _clientUrlsFor: function (type) {
    var self = this;
    return _.pluck(
      _.filter(self.manifest, function (resource) {
        return resource.where === 'client' && resource.type === type;
      }),
      'url'
    );
  },

  _generate_app_html: function () {
    var self = this;

    var template = fs.readFileSync(path.join(__dirname, "app.html.in"));
    var f = require('handlebars').compile(template.toString());
    return f({
      scripts: self._clientUrlsFor('js'),
      head_extra: self.head.join('\n'),
      body_extra: self.body.join('\n'),
      stylesheets: self._clientUrlsFor('css')
    });
  },

  // The extensions registered by the application package, if
  // any. Kind of a hack.
  _app_extensions: function () {
    var self = this;
    var exts = {};

    for (var id in self.packageBundlingInfo) {
      var inst = self.packageBundlingInfo[id];
      if (!inst.name)
        _.each(inst.api.registered_extensions(), function (ext) {
          exts[ext] = true;
        });
    }

    return _.keys(exts);
  },

  // nodeModulesMode should be "skip", "symlink", or "copy"
  write_to_directory: function (output_path, project_dir, nodeModulesMode) {
    var self = this;
    var app_json = {};
    var dependencies_json = {core: [], app: [], packages: {}};
    var is_app = files.is_app_dir(project_dir);

    if (is_app) {
      dependencies_json.app.push(path.join('.meteor', 'packages'));
      dependencies_json.app.push(path.join('.meteor', 'version'));
    }

    // --- Set up build area ---

    // foo/bar => foo/.build.bar
    var build_path = path.join(path.dirname(output_path),
                               '.build.' + path.basename(output_path));

    // XXX cleaner error handling. don't make the humans read an
    // exception (and, make suitable for use in automated systems)
    files.rm_recursive(build_path);
    files.mkdir_p(build_path, 0755);

    // --- Core runner code ---

    files.cp_r(path.join(__dirname, '..', 'server'),
               path.join(build_path, 'server'), {ignore: ignore_files});
    dependencies_json.core.push('server');

    // --- Third party dependencies ---

    if (nodeModulesMode === "symlink")
      fs.symlinkSync(path.join(files.get_dev_bundle(), 'lib', 'node_modules'),
                     path.join(build_path, 'server', 'node_modules'));
    else if (nodeModulesMode === "copy")
      files.cp_r(path.join(files.get_dev_bundle(), 'lib', 'node_modules'),
                 path.join(build_path, 'server', 'node_modules'),
                 {ignore: ignore_files});
    else
      /* nodeModulesMode === "skip" */;

    fs.writeFileSync(
      path.join(build_path, 'server', '.bundle_version.txt'),
      fs.readFileSync(
        path.join(files.get_dev_bundle(), '.bundle_version.txt')));

    // --- Static assets ---

    if (is_app) {
      if (fs.existsSync(path.join(project_dir, 'public'))) {
        var copied =
          files.cp_r(path.join(project_dir, 'public'),
                     path.join(build_path, 'static'), {ignore: ignore_files});

        _.each(copied, function (fs_relative_path) {
          var filepath = path.join(build_path, 'static', fs_relative_path);
          var normalized = fs_relative_path.split(path.sep).join('/');
          self.manifest.push({
            // path is normalized to use forward slashes, so deliberately
            // not using path.sep here
            path: 'static/' + normalized,
            type: 'static',
            where: 'client',
            cacheable: false,
            url: '/' + normalized,
            size: fs.statSync(filepath).size,
            hash: self._hash(fs.readFileSync(filepath))
          });
        });
      }
      dependencies_json.app.push('public');
    }

    // Add cache busting query param if needed, and
    // add to manifest.
    var processClientCode = function (type, file) {
      var contents, url;
      if (file in self.files.client_cacheable) {
        contents = self.files.client_cacheable[file];
        url = file;
      }
      else if (file in self.files.client) {
        // Client css and js becomes cacheable with the addition of the
        // cache busting query parameter.
        contents = self.files.client[file];
        delete self.files.client[file];
        self.files.client_cacheable[file] = contents;
        url = file + '?' + self._hash(contents)
      }
      else
        throw new Error('unable to find file: ' + file);

      self.manifest.push({
        // path is normalized to use forward slashes
        path: 'static_cacheable' + file.split(path.sep).join('/'),
        where: 'client',
        type: type,
        cacheable: true,
        url: url,
        // contents is a Buffer and so correctly gives us the size in bytes
        size: contents.length,
        hash: self._hash(contents)
      });
    };

    _.each(self.js.client, function (file) { processClientCode('js',  file); });
    _.each(self.css,       function (file) { processClientCode('css', file); });

    // -- Client code --
    for (var rel_path in self.files.client) {
      var full_path = path.join(build_path, 'static', rel_path);
      files.mkdir_p(path.dirname(full_path), 0755);
      fs.writeFileSync(full_path, self.files.client[rel_path]);
    }

    // -- Client cache forever code --
    for (var rel_path in self.files.client_cacheable) {
      var full_path = path.join(build_path, 'static_cacheable', rel_path);
      files.mkdir_p(path.dirname(full_path), 0755);
      fs.writeFileSync(full_path, self.files.client_cacheable[rel_path]);
    }

    app_json.load = [];
    files.mkdir_p(path.join(build_path, 'app'), 0755);
    for (var rel_path in self.files.server) {
      var path_in_bundle = path.join('app', rel_path);
      var full_path = path.join(build_path, path_in_bundle);
      files.mkdir_p(path.dirname(full_path), 0755);
      fs.writeFileSync(full_path, self.files.server[rel_path]);
      app_json.load.push(path_in_bundle);
    }

    // `node_modules` directories for packages
    for (var rel_path in self.nodeModulesDirs) {
      var path_in_bundle = path.join('app', rel_path);
      var full_path = path.join(build_path, path_in_bundle);

      // XXX it's bizarre that we would be trying to install npm
      // modules into a non-existant path, but this happens when we
      // have an npm dependency only used during bundle time (such as
      // the less package). we should consider supporting bundle
      // time-only npm dependencies.
      if (fs.existsSync(path.dirname(full_path))) {
        if (nodeModulesMode === 'symlink') {
          // if we symlink the dev_bundle, also symlink individual package
          // node_modules.
          fs.symlinkSync(self.nodeModulesDirs[rel_path], full_path);
        } else {
          // otherwise, copy them. if we're skipping the dev_bundle
          // modules (eg for deploy) we still need the per-package
          // modules.
          files.cp_r(self.nodeModulesDirs[rel_path], full_path);
        }
      }
    }

    fs.writeFileSync(path.join(build_path, 'app.html'),
                     self._generate_app_html());
    dependencies_json.core.push(path.join('lib', 'app.html.in'));

    fs.writeFileSync(path.join(build_path, 'unsupported.html'),
                     fs.readFileSync(path.join(__dirname, "unsupported.html")));
    dependencies_json.core.push(path.join('lib', 'unsupported.html'));

    // --- Documentation, and running from the command line ---

    fs.writeFileSync(path.join(build_path, 'main.js'),
"require(require('path').join(__dirname, 'server', 'server.js'));\n");

    fs.writeFileSync(path.join(build_path, 'README'),
"This is a Meteor application bundle. It has only one dependency,\n" +
"node.js (with the 'fibers' package). To run the application:\n" +
"\n" +
"  $ npm install fibers@1.0.0\n" +
"  $ export MONGO_URL='mongodb://user:password@host:port/databasename'\n" +
"  $ export ROOT_URL='http://example.com'\n" +
"  $ export MAIL_URL='smtp://user:password@mailhost:port/'\n" +
"  $ node main.js\n" +
"\n" +
"Use the PORT environment variable to set the port where the\n" +
"application will listen. The default is 80, but that will require\n" +
"root on most systems.\n" +
"\n" +
"Find out more about Meteor at meteor.com.\n");

    // --- Metadata ---

    app_json.manifest = self.manifest;

    dependencies_json.extensions = self._app_extensions();
    dependencies_json.exclude = _.pluck(ignore_files, 'source');
    dependencies_json.packages = {};
    for (var id in self.packageBundlingInfo) {
      var packageBundlingInfo = self.packageBundlingInfo[id];
      if (packageBundlingInfo.pkg.name) {
        dependencies_json.packages[packageBundlingInfo.pkg.name] =
            _.keys(packageBundlingInfo.dependencies);
      }
    }

    fs.writeFileSync(path.join(build_path, 'app.json'),
                     JSON.stringify(app_json, null, 2));
    fs.writeFileSync(path.join(build_path, 'dependencies.json'),
                     JSON.stringify(dependencies_json));

    // --- Move into place ---

    // XXX cleaner error handling (no exceptions)
    files.rm_recursive(output_path);
    fs.renameSync(build_path, output_path);
  }

});

///////////////////////////////////////////////////////////////////////////////
// Main
///////////////////////////////////////////////////////////////////////////////

/**
 * Take the Meteor app in project_dir, and compile it into a bundle at
 * output_path. output_path will be created if it doesn't exist (it
 * will be a directory), and removed if it does exist.
 *
 * Returns undefined on success. On failure, returns an array of
 * strings, the error messages. On failure, a bundle will still be
 * written to output_path. It is probably broken, but it is supposed
 * to contain correct dependency information, so you can tell when to
 * try bundling again.
 *
 * It's unlikely to be useful to run a package (as opposed to an app)
 * without including its tests, but it's well-defined.
 *
 * options include:
 * - noMinify : don't minify the assets
 *
 * - nodeModulesMode : decide on how to create the bundle's
 *   node_modules directory. one of:
 *     'skip' : don't create node_modules. used by `meteor deploy`, since
 *              our production servers already have all of the node modules
 *     'copy' : copy from a prebuilt local installation. used by
 *              `meteor bundle`
 *     'symlink' : symlink from a prebuild local installation. used
 *                 by `meteor run`
 *
 * - testPackages : array of package objects or package names whose
 *   tests should be included in this bundle
 *
 * - versionOverride : (for tests) a meteor release version to use
 *   instead of reading from .meteor/version
 */
exports.bundle = function (app_dir, output_path, options) {
  if (!options || !options.nodeModulesMode) {
    throw new Error("Must pass options.nodeModulesMode");
  }

  try {
    // Create a bundle, add the project
    packages.flush();

    var bundle = new Bundle;
    if (options.versionOverride)
      bundle.releaseManifest = warehouse.releaseManifestByVersion(options.versionOverride);
    else
      bundle.releaseManifest = warehouse.releaseManifestForApp(app_dir);

    // our release manifest is set, let's now load the app
    var app = packages.get_for_app(app_dir, ignore_files);
    bundle.use(app);

    // Include tests if requested
    if (options.testPackages) {
      _.each(options.testPackages, function(packageOrPackageName) {
        bundle.includeTests(packageOrPackageName);
      });
    }

    // Minify, if requested
    if (!options.noMinify)
      bundle.minify();

    // Write to disk
    bundle.write_to_directory(output_path, app_dir, options.nodeModulesMode);

    if (bundle.errors.length)
      return bundle.errors;
  } catch (err) {
    return ["Exception while bundling application:\n" + (err.stack || err)];
  }
};
