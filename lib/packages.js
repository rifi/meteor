var path = require('path');
var _ = require('underscore');
var files = require(path.join(__dirname, 'files.js'));
var fs = require('fs');
var https = require('https');
var Future = require('fibers/future');
var request = require('request');

// XXX make this work with packages.meteor.com. A CNAME record isn't
// good enough because then our SSL certs are wrong (or maybe we can
// get this to work somehow else)
var PACKAGES_URLBASE = 'https://d3fm2vapipm3k9.cloudfront.net';

// Under the hood, packages in the library (/package/foo), and user
// applications, are both Packages -- they are just represented
// differently on disk.
//
// To create a package object from a package in the library:
//   var pkg = new Package;
//   pkg.init_from_library(name);
//
// To create a package object from an app directory:
//   var pkg = new Package;
//   pkg.init_from_app_dir(app_dir);
//
// Or from a collection (a directory whose subdirs are packages):
//   var pkg = new Package;
//   pkg.init_from_collection(collection_dir);

var next_package_id = 1;
var Package = function () {
  var self = this;

  // Fields set by init_*:
  // name: package name, or null for an app pseudo-package or collection
  // source_root: base directory for resolving source files, null for collection
  // serve_root: base directory for serving files, null for collection

  // A unique ID (guaranteed to not be reused in this process -- if
  // the package is reloaded, it will get a different id the second
  // time)
  self.id = next_package_id++;

  // package metadata, from describe()
  self.metadata = {};

  self.on_use_handler = null;
  self.on_test_handler = null;

  // registered source file handlers
  self.extensions = {};

  // functions that can be called when the package is scanned
  self.declarationFuncs = {
    // keys
    // - summary: for 'meteor list'
    // - internal: if true, hide in list
    // - environments: optional
    //   (1) if present, if depended on in an environment not on this
    //       list, then throw an error
    //   (2) if present, these are also the environments that will be
    //       used when an application uses the package (since it can't
    //       specify environments.) if not present, apps will use
    //       [''], which is suitable for a package that doesn't care
    //       where it's loaded (like livedata.)
    describe: function (metadata) {
      _.extend(self.metadata, metadata);
    },

    on_use: function (f) {
      if (self.on_use_handler)
        throw new Error("A package may have only one on_use handler");
      self.on_use_handler = f;
    },

    on_test: function (f) {
      if (self.on_test_handler)
        throw new Error("A package may have only one on_test handler");
      self.on_test_handler = f;
    },

    register_extension: function (extension, callback) {
      if (_.has(self.extensions, extension))
        throw new Error("This package has already registered a handler for " +
                        extension);
      self.extensions[extension] = callback;
    },

    // Same as node's default `require` but is relative to the
    // package's directory. Regular `require` doesn't work well
    // because we read the package.js file and `runInThisContext` it
    // separately as a string.  This means that paths are relative to
    // the top-level meteor.js script rather than the location of
    // package.js
    require: function(filename) {
      return require(path.join(self.source_root, filename));
    }
  };
};

_.extend(Package.prototype, {
  // @returns {Boolean} was the package found in any local package sets?
  initFromLocalPackageSets: function (name) {
    var self = this;
    var setsDir = path.join(__dirname, '..', 'local-package-sets');
    if (!fs.existsSync(setsDir))
      return false;

    var sets = fs.readdirSync(setsDir);
    var found = false;
    _.each(sets, function (set) {

      if (found)
        return;

      var setDir = path.join(setsDir, set);
      if (fs.statSync(setDir).isDirectory()) {
        var packageNames = fs.readdirSync(setDir);
        if (_.contains(packageNames, name)) {
          found = true;
          self._initFromPackageDir(name,
                                path.join(setsDir, set, name));
        }
      }
    });

    return found;
  },

  initFromPackageCache: function (name, version) {
    this._initFromPackageDir(name,
                            path.join(__dirname, '..', 'cache', 'packages', name, version));
  },

  init_from_app_dir: function (app_dir, ignore_files) {
    var self = this;
    self.name = null;
    self.source_root = app_dir;
    self.serve_root = path.sep;

    var sources_except = function (api, except, tests) {
      return _(self._scan_for_sources(api, ignore_files || []))
        .reject(function (source_path) {
          return (path.sep + source_path + path.sep).indexOf(path.sep + except + path.sep) !== -1;
        })
        .filter(function (source_path) {
          var is_test = ((path.sep + source_path + path.sep).indexOf(path.sep + 'tests' + path.sep) !== -1);
          return is_test === (!!tests);
        });
    };

    self.declarationFuncs.on_use(function (api) {
      // -- Packages --

      // standard client packages (for now), for the classic meteor
      // stack -- has to come before user packages, because we don't
      // (presently) require packages to declare dependencies on
      // 'standard meteor stuff' like minimongo.
      api.use(['deps', 'session', 'livedata', 'mongo-livedata', 'spark',
               'templating', 'startup', 'past']);
      api.use(require(path.join(__dirname, 'project.js')).get_packages(app_dir));

      // -- Source files --
      api.add_files(sources_except(api, "server"), "client");
      api.add_files(sources_except(api, "client"), "server");
    });

    self.declarationFuncs.on_test(function (api) {
      api.use(self);
      api.add_files(sources_except(api, "server", true), "client");
      api.add_files(sources_except(api, "client", true), "server");
    });
  },

  // Find all files under this.source_root that have an extension we
  // recognize, and return them as a list of paths relative to
  // source_root. Ignore files that match a regexp in the ignore_files
  // array, if given. As a special case (ugh), push all html files to
  // the head of the list.
  _scan_for_sources: function (api, ignore_files) {
    var self = this;

    // find everything in tree, sorted depth-first alphabetically.
    var file_list = files.file_list_sync(self.source_root,
                                         api.registered_extensions());
    file_list = _.reject(file_list, function (file) {
      return _.any(ignore_files || [], function (pattern) {
        return file.match(pattern);
      });
    });
    file_list.sort(files.sort);

    // XXX HUGE HACK --
    // push html (template) files ahead of everything else. this is
    // important because the user wants to be able to say
    // Template.foo.events = { ... }
    //
    // maybe all of the templates should go in one file? packages
    // should probably have a way to request this treatment (load
    // order depedency tags?) .. who knows.
    var htmls = [];
    _.each(file_list, function (filename) {
      if (path.extname(filename) === '.html') {
        htmls.push(filename);
        file_list = _.reject(file_list, function (f) { return f === filename;});
      }
    });
    file_list = htmls.concat(file_list);

    // now make everything relative to source_root
    var prefix = self.source_root;
    if (prefix[prefix.length - 1] !== path.sep)
      prefix += path.sep;

    return file_list.map(function (abs) {
      if (path.relative(prefix, abs).match(/\.\./))
        // XXX audit to make sure it works in all possible symlink
        // scenarios
        throw new Error("internal error: source file outside of parent?");
      return abs.substr(prefix.length);
    });
  },

  _initFromPackageDir: function (name, dir) {
    var self = this;
    self.name = name;
    self.source_root = dir;
    self.serve_root = path.join(path.sep, 'packages', name);

    if (!fs.existsSync(self.source_root))
      throw new Error("The package named " + self.name + " does not exist.");

    // We use string concatenation to load package.js rather than
    // directly `require`ing it because that allows us to simplify the
    // package API (such as supporting Package.on_use rather than
    // something like Package.current().on_use)

    var fullpath = path.join(self.source_root, 'package.js');
    var code = fs.readFileSync(fullpath).toString();
    // \n is necessary in case final line is a //-comment
    var wrapped = "(function(Package,require){" + code + "\n})";
    // XXX it'd be nice to runInNewContext so that the package
    // setup code can't mess with our globals, but objects that
    // come out of runInNewContext have bizarro antimatter
    // prototype chains and break 'instanceof Array'. for now,
    // steer clear
    var func = require('vm').runInThisContext(wrapped, fullpath, true);
    // XXX would be nice to eliminate require. packages like
    // 'templating' use this to load other code to run at
    // bundle-time. and to pull in, eg, 'fs' and 'path' to access
    // the file system
    func(self.declarationFuncs, require);
  },

  init_from_collection: function (collection_dir) {
    var self = this;
    self.name = null;
    self.source_root = null;
    self.serve_root = null;

    self.declarationFuncs.on_test(function (api) {
      _.each(fs.readdirSync(collection_dir), function (name) {
        // only take things that are actually packages
        if (files.is_package_dir(path.join(collection_dir, name)))
          api.include_tests(name);
      });
    });
  }
});

// in the future, this could be an on-disk cache that tracks mtimes.
var package_cache = {};

var packages = module.exports = {

  // @param manifest {Object} parsed manifest file for appropriate meteor release
  //
  // XXX we should probably instead refactor packages to be a class
  // rather than a global object, in which case this would be passed
  // into the constructor and ensureManifestSet() would no longer be
  // needed.
  setManifest: function (manifest) {
    if (this.manifest)
      throw new Error("Can't set manifest twice");
    this.manifest = manifest;
  },

  ensureManifestSet: function() {
    if (!this.manifest)
      throw new Error(
        "No manifest set. You need to call setManifest before taking this action.");
  },

  // get a package by name. also maps package objects to themselves.
  get: function (name) {
    var self = this;
    if (name instanceof Package)
      return name;
    if (!(name in package_cache)) {
      var pkg = new Package;
      if (!pkg.initFromLocalPackageSets(name)) {
        self.ensureManifestSet();
        pkg.initFromPackageCache(name, self.manifest.packages[name]);
      }
      package_cache[name] = pkg;
    }

    return package_cache[name];
  },

  // get a package that represents an app. (ignore_files is optional
  // and if given, it should be an array of regexps for filenames to
  // ignore when scanning for source files.)
  get_for_app: function (app_dir, ignore_files) {
    var pkg = new Package;
    pkg.init_from_app_dir(app_dir, ignore_files || []);
    return pkg;
  },

  get_for_collection: function (collection_dir) {
    var pkg = new Package;
    pkg.init_from_collection(collection_dir);
    return pkg;
  },

  // get a package that represents a particular directory on disk,
  // which might be an app, a package, or even a collection of
  // packages.
  get_for_dir: function (project_dir) {
    if (files.is_app_dir(project_dir))
      return packages.get_for_app(project_dir);
    else if (files.is_package_dir(project_dir))
      // this will need to change when packages are stored in more
      // than one place
      return packages.get(path.basename(project_dir));
    else if (files.is_package_collection_dir(project_dir))
      return packages.get_for_collection(project_dir);
    else
      throw new Error("Unknown project directory type");
  },

  // force reload of all packages
  flush: function () {
    package_cache = {};
  },

  // get all packages available, in both local package sets and in the package
  // cache (in case we are in an app directory)
  // returns {Object} maps name to Package
  list: function () {
    var self = this;
    var list = {};

    var setsDir = path.join(__dirname, '..', 'local-package-sets');
    if (fs.existsSync(setsDir)) {
      var sets = fs.readdirSync(setsDir);
      _.each(sets, function (set) {
        var setDir = path.join(setsDir, set);
        if (fs.statSync(setDir).isDirectory()) {
          var packageNames = fs.readdirSync(path.join(setsDir, set));
          _.each(packageNames, function (name) {
            if (!list[name])
              list[name] = packages.get(name);
            else
              throw new Error("Found package " + name + " more than once in local package sets.");
          });
        }
      });
    }

    if (self.manifest) {
      _.each(self.manifest.packages, function(version, name) {
        // don't even look for packages if they've already been
        // overridden (though this `if` isn't necessary for
        // correctness, since `packages.get` looks for packages in the
        // override directories first anyways)
        if (!list[name])
          list[name] = packages.get(name);
      });
    }

    return list;
  },

  // returns a pretty list suitable for showing to the user. input is
  // a list of package objects, each of which must have a name (not be
  // an application package.)
  format_list: function (pkgs) {
    var longest = '';
    _.each(pkgs, function (pkg) {
      if (pkg.name.length > longest.length)
        longest = pkg.name;
    });
    var pad = longest.replace(/./g, ' ');
    // it'd be nice to read the actual terminal width, but I tried
    // several methods and none of them work (COLUMNS isn't set in
    // node's environment; `tput cols` returns a constant 80.) maybe
    // node is doing something weird with ptys.
    var width = 80;

    var out = '';
    _.each(pkgs, function (pkg) {
      if (pkg.metadata.internal)
        return;
      var name = pkg.name + pad.substr(pkg.name.length);
      var summary = pkg.metadata.summary || 'No description';
      out += (name + "  " +
              summary.substr(0, width - 2 - pad.length) + "\n");
    });

    return out;
  },

  existsInPackageCache: function (name, version) {
    // Look for presence of "package.js" file in directory so we don't count
    // an empty dir as a package.  An empty dir could be left by a failed
    // package untarring, for example.
    return fs.existsSync(path.join(__dirname, '..', 'cache', 'packages', name, version,
                                   'package.js'));
  },

  // fetches the manifest file for the given release version. also fetches
  // all of the missing versioned packages referenced from the manifest
  // @param releaseVersion {String} eg "0.1"
  // @returns {Object} parsed manifest file
  populateCacheForReleaseVersion: function(releaseVersion) {
    var self = this;
    var future = new Future;
    var manifestDir = path.join(__dirname, '..', 'cache');
    files.mkdir_p(manifestDir, 0755);
    var manifestPath = path.join(manifestDir, releaseVersion + '.json');

    // load the manifest from s3, and store in the cache
    try {
      // a variation on request that has a standard (error, result) callback.
      // this way we can use Future.wrap
      var request2 = function(url, cb) {
        request(url, function(error, response, body) {
          cb(error, body);
        });
      };

      var manifest = Future.wrap(request2)(
        PACKAGES_URLBASE + "/manifest/" + releaseVersion + ".json").wait();
      fs.writeFileSync(manifestPath, manifest);
      return JSON.parse(manifest);
    } catch (e) {
      console.error(
        "Can't find manifest for meteor release version " + releaseVersion);
      throw e;
    }
  },

  // Look for ./.meteor/version. If it exists, presumable since we're
  // inside a project load the manifest corresponding to that meteor
  // release version
  loadManifestForProjectIfExists: function () {
    var self = this;
    var project = require(path.join(__dirname, 'project.js'));
    if (fs.existsSync('.meteor/version')) {
      var releaseVersion = project.getMeteorReleaseVersion();
      var manifestPath = path.join(
        __dirname, '..', 'cache', 'manifest', releaseVersion + '.json');

      var manifest;
      if (fs.existsSync(manifestPath)) {

        // read from cache
        manifest = JSON.parse(fs.readFileSync(manifestPath));
        packages.setManifest(manifest);
      } else {

        // grow cache with new manifest and packages
        manifest = packages.populateCacheForReleaseVersion(releaseVersion);
        packages.setManifest(manifest);
      }

      var exec = require('child_process').exec;
      var Future = require('fibers/future');
      var futures = [];
      _.each(manifest.packages, function (version, name) {
        if (!self.existsInPackageCache(name, version)) {
          var packageDir = path.join(__dirname, '..', 'cache', 'packages', name, version);
          var packageUrl = PACKAGES_URLBASE + "/packages/" + name + "/" +
                version + ".tar.gz";

          console.log("Fetching " + packageUrl + "...");
          futures.push(Future.wrap(function (cb) {
            files.getUrl({url: packageUrl, encoding: null}, function (error, result) {
              if (! error && result)
                result = { buffer: result, packageDir: packageDir };
              cb(error, result);
            });
          })());
        }
      });

      Future.wait(futures);

      _.each(futures, function (f) {
        var result = f.get();
        files.mkdir_p(result.packageDir);
        files.extractTarGz(result.buffer, result.packageDir);
      });
    }
  }
};

packages.loadManifestForProjectIfExists();
