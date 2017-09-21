var request = require('request');
var q = require('q');
var _ = require('underscore');
var querystring = require('querystring');

var api = exports = module.exports = {};

api.init = function() {
  this.tokenPromise = null;
  this.refreshToken = null;
  this.settings = {};
  this.defaultConfiguration();
};

api.defaultConfiguration = function() {
  this.set('tokenEndpoint', 'token');
  this.set('maxLimit', 500);
};

api.urlFor = function(resource, id, parameters) {
  var url = this.settings.url + '/' + resource;
  if (id) {
    url = url + '/' + id;
  }

  if (parameters) {
    url = url + '?' + querystring.stringify(parameters);
  }

  return url;
};

api.getTokens = function() {
  var self = this;
  this.tokenPromise = this.tokenPromise || this.settings.tokenFetcher(this.refreshToken).then(function(tokens){
    if (tokens.refresh_token) {
      this.refreshToken = tokens.refresh_token;
    }

    return tokens;
  }).fail(function(error) {
    self.tokenPromise = null;
    throw error;
  });

  return this.tokenPromise;
};

api.setTokens = function(tokens) {
  if (tokens.refresh_token) {
    this.refreshToken = tokens.refresh_token;
  }

  this.tokenPromise = q.fulfill(tokens);
};

api.get = function(resource, id, parameters) {
  var deferred = q.defer();
  if (!id) {
    deferred.reject({error: {message: "An id is required"}});
    return deferred.promise;
  }

  return this.getTokens().then(_.bind(function(tokens) {
    var req = {url: this.urlFor(resource, id, parameters), headers: {'Authorization': 'Bearer ' + tokens.access_token}, json: true};

    request(req, resolveResponse(deferred, this, req));

    return deferred.promise;
  }, this));
};

api.getResult = function(resource, id, parameters) {
  return this.get(resource, id, parameters).get('body').get('result');
};

api.index = function(resource, parameters) {
  return this.getTokens().then(_.bind(function(tokens) {
    var deferred = q.defer();
    var req = {url: this.urlFor(resource, null, parameters), headers: {'Authorization': 'Bearer ' + tokens.access_token}, json: true};

    request(req, resolveResponse(deferred, this, req));

    return deferred.promise;
  }, this));
};

api.indexAll = function(resource, parameters) {
  var promises = [];
  promises.push(this.index(resource, _.extend({}, parameters, {offset: 0, limit: this.settings.maxLimit})));
  return promises[0].then(_.bind(function(firstPage) {
    for (var offset = this.settings.maxLimit; offset < firstPage.body.pagination.total; offset += this.settings.maxLimit) {
      promises.push(this.index(resource, _.extend({}, parameters, {offset: offset, limit: this.settings.maxLimit})));
    }

    return q.all(promises).then(function(pages) {
      return _.flatten(_.pluck(_.pluck(pages, 'body'), 'result'), true);
    });
  }, this));
};

api.post = function(resource, parameters) {
  var deferred = q.defer();

  return this.getTokens().then(_.bind(function(tokens) {
    var req = {
      url: this.urlFor(resource),
      method: 'POST',
      json: parameters,
      headers: {'Authorization': 'Bearer ' + tokens.access_token}
    };

    request(req, resolveResponse(deferred, this, req));

    return deferred.promise;
  }, this));
}

api.put = function(resource, id, parameters) {
  var deferred = q.defer();

  return this.getTokens().then(_.bind(function(tokens) {
    var req = {
      url: this.urlFor(resource, id),
      method: 'PUT',
      json: parameters,
      headers: {'Authorization': 'Bearer ' + tokens.access_token}
    };

    request(req, resolveResponse(deferred, this, req));

    return deferred.promise;
  }, this));
}

api.delete = function(resource, id) {
  var deferred = q.defer();

  return this.getTokens().then(_.bind(function(tokens) {
    var req = {
      url: this.urlFor(resource, id),
      method: 'DELETE',
      headers: {'Authorization': 'Bearer ' + tokens.access_token}
    };

    request(req, resolveResponse(deferred, this, req));

    return deferred.promise;
  }, this));
}

api.deleteByParams = function(resource, parameters) {
  var deferred = q.defer();

  return this.getTokens().then(_.bind(function(tokens) {
    var req = {
      url: this.urlFor(resource),
      method: 'DELETE',
      json: parameters,
      headers: {'Authorization': 'Bearer ' + tokens.access_token}
    };

    request(req, resolveResponse(deferred, this, req));

    return deferred.promise;
  }, this));
}

api.set = function(setting, value) {
  if (arguments.length == 1) {
    return this.settings[setting];
  }

  this.settings[setting] = value;
  return this;
};

function resolveResponse(deferred, api, req) {
  return function(error, res, body) {
    if (error) {
      deferred.reject(error);
    } else if (api && req && isExpiredToken(res, body)) {
      api.tokenPromise = null;
      api.getTokens().then(_.bind(function(tokens) {
        req.headers.Authorization = 'Bearer ' + tokens.access_token;
        request(req, resolveResponse(deferred, api, req));
      }, api), function(error) {
        deferred.reject({res: error.res, body: error.body});
      });
    } else if (res.statusCode >= 400) {
      deferred.reject({res: res, body: body});
    } else {
      deferred.resolve({res: res, body: body});
    }
  };
}

function isExpiredToken(res, body) {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return false;
    }
  }

  return res.statusCode == 401 && body.error === 'invalid_grant';
}

api.getClientCredentialsToken = function(tokenUrl, clientId, clientSecret) {
  var deferred = q.defer();

  request(
    {
      url: tokenUrl,
      method: 'POST',
      form: {grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret},
      json: true
    },
    resolveResponse(deferred)
  );

  return deferred.promise.then(parseTokenResponse);
};

api.handleRefreshToken = function(tokenUrl, clientId, clientSecret, scope, refreshToken) {
  var deferred = q.defer();

  var form = {grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken};
  if (scope !== undefined) {
    form.scope = scope;
  }

  request({url: tokenUrl, method: 'POST', form: form, json: true}, resolveResponse(deferred));

  return deferred.promise.then(parseTokenResponse);
};

api.getResourceOwnerPasswordCredentialsToken = function(tokenUrl, clientId, clientSecret, username, password, scope, extra) {
  var deferred = q.defer();

  var form = {grant_type: 'password', client_id: clientId, client_secret: clientSecret, username: username, password: password};

  if (extra) {
    _.extend(form, extra);
  }

  if (scope !== undefined) {
    form.scope = scope;
  }

  request(
    {
      url: tokenUrl,
      method: 'POST',
      form: form,
      json: true
    },
    resolveResponse(deferred)
  );

  return deferred.promise.then(parseTokenResponse);
};

function parseTokenResponse(res) {
  if (res.body.access_token) {
    var tokens = {access_token: res.body.access_token};
    if (res.body.refresh_token) {
      tokens.refresh_token = res.body.refresh_token;
    }

    return tokens;
  } else {
    throw { error: "Invalid response: " + res.body }
  }
}
