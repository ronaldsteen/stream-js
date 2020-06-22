import request from 'request';
import qs from 'qs';
import Url from 'url';
import http from 'http';
import https from 'https';
import Faye from 'faye';
import jwtDecode from 'jwt-decode';
import assignIn from 'lodash/assignIn';

import Personalization from './personalization';
import BatchOperations from './batch_operations';
import Collections from './collections';
import StreamFeed from './feed';
import StreamFileStore from './files';
import StreamImageStore from './images';
import StreamReaction from './reaction';
import StreamUser from './user';
import Promise from './promise';
import signing from './signing';
import errors from './errors';
import utils from './utils';

/**
 * @callback requestCallback
 * @param {object} [errors]
 * @param {object} response
 * @param {object} body
 */

/**
 * Client to connect to Stream api
 * @class StreamClient
 */
class StreamClient {
  constructor(apiKey, apiSecretOrToken, appId, options = {}) {
    /**
     * Initialize a client
     * @method intialize
     * @memberof StreamClient.prototype
     * @param {string} apiKey - the api key
     * @param {string} [apiSecret] - the api secret
     * @param {string} [appId] - id of the app
     * @param {object} [options] - additional options
     * @param {string} [options.location] - which data center to use
     * @param {boolean} [options.expireTokens=false] - whether to use a JWT timestamp field (i.e. iat)
     * @example <caption>initialize is not directly called by via stream.connect, ie:</caption>
     * stream.connect(apiKey, apiSecret)
     * @example <caption>secret is optional and only used in server side mode</caption>
     * stream.connect(apiKey, null, appId);
     */

    this.baseUrl = 'https://api.stream-io-api.com/api/';
    this.baseAnalyticsUrl = 'https://analytics.stream-io-api.com/analytics/';
    this.apiKey = apiKey;
    this.usingApiSecret = apiSecretOrToken != null && !signing.isJWT(apiSecretOrToken);
    this.apiSecret = this.usingApiSecret ? apiSecretOrToken : null;
    this.userToken = this.usingApiSecret ? null : apiSecretOrToken;
    this.enrichByDefault = !this.usingApiSecret;

    if (this.userToken != null) {
      const jwtBody = jwtDecode(this.userToken);
      if (!jwtBody.user_id) {
        throw new TypeError('user_id is missing in user token');
      }
      this.userId = jwtBody.user_id;
      this.currentUser = this.user(this.userId);
      this.authPayload = jwtBody;
    }

    this.appId = appId;
    this.options = options;
    this.version = this.options.version || 'v1.0';
    this.fayeUrl = this.options.fayeUrl || 'https://faye-us-east.stream-io-api.com/faye';
    this.fayeClient = null;
    this.request = request;
    // track a source name for the api calls, ie get started or databrowser
    this.group = this.options.group || 'unspecified';
    // track subscriptions made on feeds created by this client
    this.subscriptions = {};
    this.expireTokens = this.options.expireTokens ? this.options.expireTokens : false;
    // which data center to use
    this.location = this.options.location;
    this.baseUrl = this.getBaseUrl();

    if (typeof process !== 'undefined' && process.env.LOCAL_FAYE) {
      this.fayeUrl = 'http://localhost:9999/faye/';
    }

    if (typeof process !== 'undefined' && process.env.STREAM_ANALYTICS_BASE_URL) {
      this.baseAnalyticsUrl = process.env.STREAM_ANALYTICS_BASE_URL;
    }

    this.handlers = {};
    this.browser = typeof this.options.browser !== 'undefined' ? this.options.browser : typeof window !== 'undefined';
    this.node = !this.browser;

    if (!this.browser) {
      const keepAlive = this.options.keepAlive === undefined ? true : this.options.keepAlive;

      const httpsAgent = new https.Agent({
        keepAlive,
        keepAliveMsecs: 3000,
      });

      const httpAgent = new http.Agent({
        keepAlive,
        keepAliveMsecs: 3000,
      });

      this.requestAgent = this.baseUrl.startsWith('https://') ? httpsAgent : httpAgent;
    }

    this.personalization = new Personalization(this);

    /* istanbul ignore next */
    if (this.browser && this.usingApiSecret) {
      throw new errors.FeedError(
        'You are publicly sharing your App Secret. Do not expose the App Secret in browsers, "native" mobile apps, or other non-trusted environments.',
      );
    }
    this.collections = new Collections(this, this.getOrCreateToken());
    this.files = new StreamFileStore(this, this.getOrCreateToken());
    this.images = new StreamImageStore(this, this.getOrCreateToken());
    this.reactions = new StreamReaction(this, this.getOrCreateToken());
  }

  getPersonalizationToken() {
    if (this._personalizationToken) {
      return this._personalizationToken;
    }

    if (this.apiSecret) {
      this._personalizationToken = signing.JWTScopeToken(this.apiSecret, 'personalization', '*', {
        userId: '*',
        feedId: '*',
        expireTokens: this.expireTokens,
      });
    } else {
      throw new errors.SiteError(
        'Missing secret, which is needed to perform signed requests, use var client = stream.connect(key, secret);',
      );
    }

    return this._personalizationToken;
  }

  getCollectionsToken() {
    if (this._collectionsToken) {
      return this._collectionsToken;
    }

    if (this.apiSecret) {
      this._collectionsToken = signing.JWTScopeToken(this.apiSecret, 'collections', '*', {
        feedId: '*',
        expireTokens: this.expireTokens,
      });
    } else {
      throw new errors.SiteError(
        'Missing secret, which is needed to perform signed requests, use var client = stream.connect(key, secret);',
      );
    }

    return this._collectionsToken;
  }

  getAnalyticsToken() {
    if (this.apiSecret) {
      return signing.JWTScopeToken(this.apiSecret, 'analytics', '*', {
        userId: '*',
        expireTokens: this.expireTokens,
      });
    }
    throw new errors.SiteError(
      'Missing secret, which is needed to perform signed requests, use var client = stream.connect(key, secret);',
    );
  }

  getBaseUrl(serviceName) {
    if (!serviceName) {
      serviceName = 'api';
    }
    let url = this.baseUrl;
    if (serviceName !== 'api') {
      url = `https://${serviceName}.stream-io-api.com/${serviceName}/`;
    }

    if (this.location) {
      const protocol = this.options.protocol || 'https';
      url = `${protocol}://${this.location}-${serviceName}.stream-io-api.com/${serviceName}/`;
    }

    if ((typeof process !== 'undefined' && process.env.LOCAL) || this.options.local) {
      url = `http://localhost:8000/${serviceName}/`;
    }

    let urlEnvironmentKey;
    if (serviceName === 'api') {
      urlEnvironmentKey = 'STREAM_BASE_URL';
    } else {
      urlEnvironmentKey = `STREAM_${serviceName.toUpperCase()}_URL`;
    }
    if (typeof process !== 'undefined' && process.env[urlEnvironmentKey]) {
      url = process.env[urlEnvironmentKey];
    }
    if (this.options.urlOverride && this.options.urlOverride[serviceName]) {
      return this.options.urlOverride[serviceName];
    }

    return url;
  }

  on(event, callback) {
    /**
     * Support for global event callbacks
     * This is useful for generic error and loading handling
     * @method on
     * @memberof StreamClient.prototype
     * @param {string} event - Name of the event
     * @param {function} callback - Function that is called when the event fires
     * @example
     * client.on('request', callback);
     * client.on('response', callback);
     */
    this.handlers[event] = callback;
  }

  off(key) {
    /**
     * Remove one or more event handlers
     * @method off
     * @memberof StreamClient.prototype
     * @param {string} [key] - Name of the handler
     * @example
     * client.off() removes all handlers
     * client.off(name) removes the specified handler
     */
    if (key === undefined) {
      this.handlers = {};
    } else {
      delete this.handlers[key];
    }
  }

  send(...args) {
    /**
     * Call the given handler with the arguments
     * @method send
     * @memberof StreamClient.prototype
     * @access private
     */

    const key = args[0];
    args = args.slice(1);
    if (this.handlers[key]) {
      this.handlers[key].apply(this, args);
    }
  }

  wrapPromiseTask(cb, fulfill, reject) {
    /**
     * Wrap a task to be used as a promise
     * @method wrapPromiseTask
     * @memberof StreamClient.prototype
     * @private
     * @param {requestCallback} cb
     * @param {function} fulfill
     * @param {function} reject
     * @return {function}
     */
    const client = this;

    const callback = this.wrapCallback(cb);
    return function task(error, response, body) {
      if (error) {
        reject(new errors.StreamApiError(error, body, response));
      } else if (!/^2/.test(`${response.statusCode}`)) {
        reject(
          new errors.StreamApiError(
            `${JSON.stringify(body)} with HTTP status code ${response.statusCode}`,
            body,
            response,
          ),
        );
      } else {
        fulfill(body);
      }

      callback.call(client, error, response, body);
    };
  }

  wrapCallback(cb) {
    /**
     * Wrap callback for HTTP request
     * @method wrapCallBack
     * @memberof StreamClient.prototype
     * @access private
     */

    const callback = (...args) => {
      // first hit the global callback, subsequently forward
      const sendArgs = ['response'].concat(args);
      this.send(sendArgs);
      if (cb !== undefined) {
        cb.apply(this, args);
      }
    };

    return callback;
  }

  userAgent() {
    /**
     * Get the current user agent
     * @method userAgent
     * @memberof StreamClient.prototype
     * @return {string} current user agent
     */
    const description = this.node ? 'node' : 'browser';
    // TODO: get the version here in a way which works in both and browserify
    const version = 'unknown';
    return `stream-javascript-client-${description}-${version}`;
  }

  getReadOnlyToken(feedSlug, userId) {
    /**
     * Returns a token that allows only read operations
     *
     * @method getReadOnlyToken
     * @memberof StreamClient.prototype
     * @param {string} feedSlug - The feed slug to get a read only token for
     * @param {string} userId - The user identifier
     * @return {string} token
     * @example
     * client.getReadOnlyToken('user', '1');
     */
    return this.feed(feedSlug, userId).getReadOnlyToken();
  }

  getReadWriteToken(feedSlug, userId) {
    /**
     * Returns a token that allows read and write operations
     *
     * @method getReadWriteToken
     * @memberof StreamClient.prototype
     * @param {string} feedSlug - The feed slug to get a read only token for
     * @param {string} userId - The user identifier
     * @return {string} token
     * @example
     * client.getReadWriteToken('user', '1');
     */
    return this.feed(feedSlug, userId).getReadWriteToken();
  }

  feed(feedSlug, userId = this.userId, token) {
    /**
     * Returns a feed object for the given feed id and token
     * @method feed
     * @memberof StreamClient.prototype
     * @param {string} feedSlug - The feed slug
     * @param {string} userId - The user identifier
     * @param {string} [token] - The token (DEPRECATED)
     * @return {StreamFeed}
     * @example
     * client.feed('user', '1');
     */

    if (token === undefined) {
      if (this.usingApiSecret) {
        token = signing.JWTScopeToken(this.apiSecret, '*', '*', {
          feedId: `${feedSlug}${userId}`,
        });
      } else {
        token = this.userToken;
      }
    }

    if (userId instanceof StreamUser) {
      userId = userId.id;
    }

    return new StreamFeed(this, feedSlug, userId, token);
  }

  enrichUrl(relativeUrl, serviceName) {
    /**
     * Combines the base url with version and the relative url
     * @method enrichUrl
     * @memberof StreamClient.prototype
     * @private
     * @param {string} relativeUrl
     */
    if (!serviceName) {
      serviceName = 'api';
    }

    return `${this.getBaseUrl(serviceName) + this.version}/${relativeUrl}`;
  }

  replaceReactionOptions = (options) => {
    // Shortcut options for reaction enrichment
    if (options && options.reactions) {
      if (options.reactions.own != null) {
        options.withOwnReactions = options.reactions.own;
      }
      if (options.reactions.recent != null) {
        options.withRecentReactions = options.reactions.recent;
      }
      if (options.reactions.counts != null) {
        options.withReactionCounts = options.reactions.counts;
      }
      if (options.reactions.own_children != null) {
        options.withOwnChildren = options.reactions.own_children;
      }
      delete options.reactions;
    }
  };

  shouldUseEnrichEndpoint(options) {
    if (options && options.enrich) {
      const result = options.enrich;
      delete options.enrich;
      return result;
    }

    return (
      this.enrichByDefault ||
      options.ownReactions != null ||
      options.withRecentReactions != null ||
      options.withReactionCounts != null ||
      options.withOwnChildren != null
    );
  }

  enrichKwargs(kwargs) {
    /**
     * Adds the API key and the signature
     * @method enrichKwargs
     * @memberof StreamClient.prototype
     * @param {object} kwargs
     * @private
     */
    kwargs.url = this.enrichUrl(kwargs.url, kwargs.serviceName);
    if (kwargs.qs === undefined) {
      kwargs.qs = {};
    }

    if (!this.browser) {
      kwargs.agent = this.requestAgent;
    }

    kwargs.qs.api_key = this.apiKey;
    kwargs.qs.location = this.group;
    kwargs.json = true;
    let signature = kwargs.signature || this.signature;
    kwargs.headers = {};

    // auto-detect authentication type and set HTTP headers accordingly
    if (signing.isJWTSignature(signature)) {
      kwargs.headers['stream-auth-type'] = 'jwt';
      signature = signature.split(' ').reverse()[0];
    } else {
      kwargs.headers['stream-auth-type'] = 'simple';
    }
    kwargs.timeout = 10 * 1000; // 10 seconds

    kwargs.headers.Authorization = signature;
    kwargs.headers['X-Stream-Client'] = this.userAgent();
    // Make sure withCredentials is not enabled, different browser
    // fallbacks handle it differently by default (meteor)
    kwargs.withCredentials = false;
    return kwargs;
  }

  getFayeAuthorization() {
    /**
     * Get the authorization middleware to use Faye with getstream.io
     * @method getFayeAuthorization
     * @memberof StreamClient.prototype
     * @private
     * @return {object} Faye authorization middleware
     */
    const { apiKey } = this;

    return {
      incoming: (message, callback) => {
        callback(message);
      },

      outgoing: (message, callback) => {
        if (message.subscription && this.subscriptions[message.subscription]) {
          const subscription = this.subscriptions[message.subscription];

          message.ext = {
            user_id: subscription.userId,
            api_key: apiKey,
            signature: subscription.token,
          };
        }

        callback(message);
      },
    };
  }

  getFayeClient() {
    /**
     * Returns this client's current Faye client
     * @method getFayeClient
     * @memberof StreamClient.prototype
     * @private
     * @return {object} Faye client
     */
    if (this.fayeClient === null) {
      this.fayeClient = new Faye.Client(this.fayeUrl, { timeout: 10 });
      const authExtension = this.getFayeAuthorization();
      this.fayeClient.addExtension(authExtension);
    }

    return this.fayeClient;
  }

  get(kwargs, cb) {
    /**
     * Shorthand function for get request
     * @method get
     * @memberof StreamClient.prototype
     * @private
     * @param  {object}   kwargs
     * @param  {requestCallback} cb     Callback to call on completion
     * @return {Promise}                Promise object
     */
    return new Promise(
      function (fulfill, reject) {
        this.send('request', 'get', kwargs, cb);
        kwargs = this.enrichKwargs(kwargs);
        kwargs.method = 'GET';
        kwargs.gzip = true;
        const callback = this.wrapPromiseTask(cb, fulfill, reject);
        this.request(kwargs, callback);
      }.bind(this),
    );
  }

  post(kwargs, cb) {
    /**
     * Shorthand function for post request
     * @method post
     * @memberof StreamClient.prototype
     * @private
     * @param  {object}   kwargs
     * @param  {requestCallback} cb     Callback to call on completion
     * @return {Promise}                Promise object
     */
    return new Promise(
      function (fulfill, reject) {
        this.send('request', 'post', kwargs, cb);
        kwargs = this.enrichKwargs(kwargs);
        kwargs.method = 'POST';
        kwargs.gzip = true;
        const callback = this.wrapPromiseTask(cb, fulfill, reject);
        this.request(kwargs, callback);
      }.bind(this),
    );
  }

  delete(kwargs, cb) {
    /**
     * Shorthand function for delete request
     * @method delete
     * @memberof StreamClient.prototype
     * @private
     * @param  {object}   kwargs
     * @param  {requestCallback} cb     Callback to call on completion
     * @return {Promise}                Promise object
     */
    return new Promise(
      function (fulfill, reject) {
        this.send('request', 'delete', kwargs, cb);
        kwargs = this.enrichKwargs(kwargs);
        kwargs.gzip = true;
        kwargs.method = 'DELETE';
        const callback = this.wrapPromiseTask(cb, fulfill, reject);
        this.request(kwargs, callback);
      }.bind(this),
    );
  }

  put(kwargs, cb) {
    /**
     * Shorthand function for put request
     * @method put
     * @memberof StreamClient.prototype
     * @private
     * @param  {object}   kwargs
     * @param  {requestCallback} cb     Callback to call on completion
     * @return {Promise}                Promise object
     */
    return new Promise(
      function (fulfill, reject) {
        this.send('request', 'put', kwargs, cb);
        kwargs = this.enrichKwargs(kwargs);
        kwargs.method = 'PUT';
        kwargs.gzip = true;
        const callback = this.wrapPromiseTask(cb, fulfill, reject);
        this.request(kwargs, callback);
      }.bind(this),
    );
  }

  /**
   * Deprecated: use createUserToken instead
   * @param {string} userId
   * @param {object} extraData
   */
  createUserSessionToken(userId, extraData = {}) {
    if (!this.usingApiSecret || this.apiKey == null) {
      throw new errors.FeedError(
        'In order to create user tokens you need to initialize the API client with your API Secret',
      );
    }
    return signing.JWTUserSessionToken(this.apiSecret, userId, extraData, {
      noTimestamp: !this.expireTokens,
    });
  }

  createUserToken(userId, extraData = {}) {
    return this.createUserSessionToken(userId, extraData);
  }

  updateActivities(activities, callback) {
    /**
     * Updates all supplied activities on the getstream-io api
     * @since  3.1.0
     * @param  {array} activities list of activities to update
     * @return {Promise}
     */

    if (!this.usingApiSecret || this.apiKey == null) {
      throw new errors.SiteError('This method can only be used server-side using your API Secret');
    }

    if (!(activities instanceof Array)) {
      throw new TypeError('The activities argument should be an Array');
    }

    const authToken = signing.JWTScopeToken(this.apiSecret, 'activities', '*', {
      feedId: '*',
      expireTokens: this.expireTokens,
    });

    const body = { activities };

    return this.post(
      {
        url: 'activities/',
        body,
        signature: authToken,
      },
      callback,
    );
  }

  updateActivity(activity, callback) {
    /**
     * Updates one activity on the getstream-io api
     * @since  3.1.0
     * @param  {object} activity The activity to update
     * @return {Promise}
     */

    if (!this.usingApiSecret || this.apiKey == null) {
      throw new errors.SiteError('This method can only be used server-side using your API Secret');
    }

    return this.updateActivities([activity], callback);
  }

  getActivities({ ids, foreignIDTimes, ...params }, callback) {
    /**
     * Retrieve activities by ID or foreign ID and time
     * @since  3.19.0
     * @param  {object} params object containing either the list of activity IDs as {ids: ['...', ...]} or foreign IDs and time as {foreignIDTimes: [{foreignID: ..., time: ...}, ...]}
     * @return {Promise}
     */

    if (ids) {
      if (!(ids instanceof Array)) {
        throw new TypeError('The ids argument should be an Array');
      }
      params.ids = ids.join(',');
    } else if (foreignIDTimes) {
      if (!(foreignIDTimes instanceof Array)) {
        throw new TypeError('The foreignIDTimes argument should be an Array');
      }
      const foreignIDs = [];
      const timestamps = [];
      foreignIDTimes.forEach((fidTime) => {
        if (!(fidTime instanceof Object)) {
          throw new TypeError('foreignIDTimes elements should be Objects');
        }
        foreignIDs.push(fidTime.foreignID);
        timestamps.push(fidTime.time);
      });

      params.foreign_ids = foreignIDs.join(',');
      params.timestamps = timestamps.join(',');
    } else {
      throw new TypeError('Missing ids or foreignIDTimes params');
    }

    let token = this.userToken;
    if (this.usingApiSecret) {
      token = signing.JWTScopeToken(this.apiSecret, 'activities', '*', {
        feedId: '*',
        expireTokens: this.expireTokens,
      });
    }

    this.replaceReactionOptions(params);
    const path = this.shouldUseEnrichEndpoint(params) ? 'enrich/activities/' : 'activities/';

    return this.get(
      {
        url: path,
        qs: params,
        signature: token,
      },
      callback,
    );
  }

  getOrCreateToken() {
    return this.usingApiSecret ? signing.JWTScopeToken(this.apiSecret, '*', '*', { feedId: '*' }) : this.userToken;
  }

  user(userId) {
    return new StreamUser(this, userId, this.getOrCreateToken());
  }

  setUser(data) {
    if (this.usingApiSecret) {
      throw new errors.SiteError('This method can only be used client-side using a user token');
    }

    const body = { ...data };
    delete body.id;
    return this.currentUser.getOrCreate(body).then((user) => {
      this.currentUser = user;
      return user;
    });
  }

  og(url) {
    return this.get({
      url: 'og/',
      qs: { url },
      signature: this.getOrCreateToken(),
    });
  }

  personalizedFeed(options = {}, callback) {
    return this.get(
      {
        url: 'enrich/personalization/feed/',
        qs: options,
        signature: this.getOrCreateToken(),
      },
      callback,
    );
  }

  activityPartialUpdate(data, callback) {
    /**
     * Update a single activity with partial operations.
     * @since 3.20.0
     * @param {object} data object containing either the ID or the foreign ID and time of the activity and the operations to issue as set:{...} and unset:[...].
     * @return {Promise}
     * @example
     * client.activityPartialUpdate({
     *   id: "54a60c1e-4ee3-494b-a1e3-50c06acb5ed4",
     *   set: {
     *     "product.price": 19.99,
     *     "shares": {
     *       "facebook": "...",
     *       "twitter": "...",
     *     }
     *   },
     *   unset: [
     *     "daily_likes",
     *     "popularity"
     *   ]
     * })
     * @example
     * client.activityPartialUpdate({
     *   foreignID: "product:123",
     *   time: "2016-11-10T13:20:00.000000",
     *   set: {
     *     ...
     *   },
     *   unset: [
     *     ...
     *   ]
     * })
     */
    return this.activitiesPartialUpdate([data], callback).then((response) => {
      const activity = response.activities[0];
      delete response.activities;
      assignIn(activity, response);
      return activity;
    });
  }

  activitiesPartialUpdate(changes, callback) {
    /**
     * Update multiple activities with partial operations.
     * @since v3.20.0
     * @param {array} changes array containing the changesets to be applied. Every changeset contains the activity identifier which is either the ID or the pair of of foreign ID and time of the activity. The operations to issue can be set:{...} and unset:[...].
     * @return {Promise}
     * @xample
     * client.activitiesPartialUpdate([
     *   {
     *     id: "4b39fda2-d6e2-42c9-9abf-5301ef071b12",
     *     set: {
     *       "product.price.eur": 12.99,
     *       "colors": {
     *         "blue": "#0000ff",
     *         "green": "#00ff00",
     *       },
     *     },
     *     unset: [ "popularity", "size.x2" ],
     *   },
     *   {
     *     id: "8d2dcad8-1e34-11e9-8b10-9cb6d0925edd",
     *     set: {
     *       "product.price.eur": 17.99,
     *       "colors": {
     *         "red": "#ff0000",
     *         "green": "#00ff00",
     *       },
     *     },
     *     unset: [ "rating" ],
     *   },
     * ])
     * @example
     * client.activitiesPartialUpdate([
     *   {
     *     foreignID: "product:123",
     *     time: "2016-11-10T13:20:00.000000",
     *     set: {
     *       ...
     *     },
     *     unset: [
     *       ...
     *     ]
     *   },
     *   {
     *     foreignID: "product:321",
     *     time: "2016-11-10T13:20:00.000000",
     *     set: {
     *       ...
     *     },
     *     unset: [
     *       ...
     *     ]
     *   },
     * ])
     */
    if (!(changes instanceof Array)) {
      throw new TypeError('changes should be an Array');
    }
    changes.forEach(function (item) {
      if (!(item instanceof Object)) {
        throw new TypeError(`changeset should be and Object`);
      }
      if (item.foreignID) {
        item.foreign_id = item.foreignID;
      }
      if (item.id === undefined && (item.foreign_id === undefined || item.time === undefined)) {
        throw new TypeError('missing id or foreign ID and time');
      }
      if (item.set && !(item.set instanceof Object)) {
        throw new TypeError('set field should be an Object');
      }
      if (item.unset && !(item.unset instanceof Array)) {
        throw new TypeError('unset field should be an Array');
      }
    });

    let authToken = this.userToken;
    if (this.usingApiSecret) {
      authToken = signing.JWTScopeToken(this.apiSecret, 'activities', '*', {
        feedId: '*',
        expireTokens: this.expireTokens,
      });
    }

    return this.post(
      {
        url: 'activity/',
        body: {
          changes,
        },
        signature: authToken,
      },
      callback,
    );
  }
}

// StreamClient.prototype.collection = StreamClient.prototype.collections;

if (qs) {
  StreamClient.prototype.createRedirectUrl = function (targetUrl, userId, events) {
    /**
     * Creates a redirect url for tracking the given events in the context of
     * an email using Stream's analytics platform. Learn more at
     * getstream.io/personalization
     * @method createRedirectUrl
     * @memberof StreamClient.prototype
     * @param  {string} targetUrl Target url
     * @param  {string} userId    User id to track
     * @param  {array} events     List of events to track
     * @return {string}           The redirect url
     */
    const uri = Url.parse(targetUrl);

    if (!(uri.host || (uri.hostname && uri.port)) && !uri.isUnix) {
      throw new errors.MissingSchemaError(`Invalid URI: "${Url.format(uri)}"`);
    }

    const authToken = signing.JWTScopeToken(this.apiSecret, 'redirect_and_track', '*', {
      userId: '*',
      expireTokens: this.expireTokens,
    });
    const analyticsUrl = `${this.baseAnalyticsUrl}redirect/`;
    const kwargs = {
      auth_type: 'jwt',
      authorization: authToken,
      url: targetUrl,
      api_key: this.apiKey,
      events: JSON.stringify(events),
    };

    const qString = utils.rfc3986(qs.stringify(kwargs, null, null, {}));

    return `${analyticsUrl}?${qString}`;
  };
}

// If we are in a node environment and batchOperations is available add the methods to the prototype of StreamClient
if (BatchOperations) {
  Object.keys(BatchOperations).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(BatchOperations, key)) {
      StreamClient.prototype[key] = BatchOperations[key];
    }
  });
}

export default StreamClient;
