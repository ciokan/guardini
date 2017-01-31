/// <reference types="redis" />
/// <reference types="node" />
"use strict";
var fs = require("fs");
var path = require("path");
var Scripty = require('node-redis-scripty');
var Guardini = (function () {
    /**
     * Constructor for the rate limiter class
     *
     * @param redisClient: The redis connection that we use
     * @param options: Object containing global options:
     *      - plans: array of plan objects
     *          - name: the plan name
     *          - limit: what is the plan limit in seconds
     *      - isPrivate: if this is set to true, guests will be rejected
     * @param planProvider A method that provides a user plan based
     *      on supplied token. We use this only when we don't know the user
     *      plan based on history in order to avoid checking it on every request
     *      and keep our resource usage as low as possible. If there are no plans
     *      set this method will not be called and we will attempt to limit based
     *      on global limits configured. If no global limits are configured, the
     *      request will be accepted. As a matter of fact, without a global limit,
     *      all requests are accepted by default so keep that in mind.
     */
    function Guardini(redisClient, options, planProvider) {
        this.lua = this.loadScripts();
        this.redis = redisClient;
        this.options = options;
        this.planProvider = planProvider;
        this.scripty = new Scripty(this.redis);
        this.log('debug', 'Guardini instantiated');
    }
    /**
     * Main entry to perform the actual check and determine if the
     * request is allowed or not. You can use this in your middleware
     * or route.
     *
     * @param token The user token, if any
     * @param ipAddress The client ip making the request. Required!
     * @param callback A callback method which accepts one param that
     *      indicates if the request is allowed
     * @returns {null}
     */
    Guardini.prototype.check = function (token, ipAddress, callback) {
        //	Check if `tokenIsRequired` and reject the request
        //	if it's required but no token was provided by caller
        if (!this.allowsGuests() && !token) {
            return callback(null, true);
        }
        if (token) {
            this.isTokenAllowed(token, ipAddress, callback);
        }
        else {
            this.ipIsAllowed(ipAddress, callback);
        }
    };
    Object.defineProperty(Guardini.prototype, "namespace", {
        /**
         * Returns the current namespace that our instance runs under
         * We use namespaces to separate projects or differentiate
         * api gateways with different plans
         *
         * @returns {string}
         */
        get: function () {
            return ('namespace' in this.options) ? this.options['namespace'] : '';
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(Guardini.prototype, "cacheTtl", {
        /**
         * Returns the number of seconds indicating the cache interval
         * for tokens to avoid calling the `planProvider` method too much.
         * Results are cached in redis for this time period. Default is set
         * at 3600 seconds (1 hour)
         *
         * @returns {number}
         */
        get: function () {
            return ('cacheInvalidateTtl' in this.options) ? this.options['cacheInvalidateTtl'] : 3600;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(Guardini.prototype, "shouldCacheTokens", {
        /**
         * Returns true or false which indicates wether we should cache
         * token responses inside redis or not. Without caching, redis will
         * call the `planProvider` method on every request so I highly recommend
         * on enabling this one.
         *
         * @returns {boolean}
         */
        get: function () {
            return this.cacheTtl > 0;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(Guardini, "now", {
        /**
         * Utility function that returns the current unix timestamp
         * to be sent over to the lua script inside Redis
         *
         * @returns {number}
         */
        get: function () {
            return Math.round(new Date().getTime() / 1000);
        },
        enumerable: true,
        configurable: true
    });
    /**
     * When no token was supplied (or one that was not found) we will resort
     * to checking based on ip address unless the `allowsGuests` option was
     * supplied with a negative value in which case there's nothing we can do
     * but reject the request
     *
     * @param ipAddress The ip address to check against
     * @param callback A callback function that received a boolean parameter
     *      which indicates if the request is allowed or not
     * @returns {null}
     */
    Guardini.prototype.ipIsAllowed = function (ipAddress, callback) {
        if (!this.allowsGuests()) {
            return callback(null, true);
        }
        var limits = this.options.plans['free'].limits;
        var key = "rl:hit:" + ipAddress;
        this.lua.overLimitCheck(key, limits, Guardini.now, 1, callback);
    };
    Guardini.prototype.isTokenAllowed = function (token, ipAddress, callback) {
        var _this = this;
        // This key holds the token plan
        var key = this.namespace + ":rl:" + token;
        // This key holds the token counter/usage
        var checkKey = this.namespace + ":rl:hit:" + token;
        //  Try to retrieve the user plan from Redis
        this.redis.get(key, function (error, plan) {
            if (error) {
                _this.log('err', error.toString());
                return callback(error);
            }
            else {
                if (plan) {
                    _this.log('debug', 'User plan found in cache: ' + plan);
                    if (plan == 'none') {
                        return _this.ipIsAllowed(ipAddress, callback);
                    }
                    var limits = _this.getPlanLimits(plan);
                    _this.log('debug', 'Limits for ' + plan + ': ' + limits);
                    if (limits) {
                        _this.lua.overLimitCheck(checkKey, limits, Guardini.now, 1, callback);
                    }
                    else {
                        //  Plan was not found so delete this key so we can refresh our db
                        _this.redis.del(key);
                        return _this.ipIsAllowed(ipAddress, callback);
                    }
                }
                else {
                    if (_this.planProvider === undefined) {
                        _this.log('warn', 'No user plans defined');
                        //  No plan provider...check the ip method
                        return _this.ipIsAllowed(ipAddress, callback);
                    }
                    _this.log('debug', 'Will check plan provider for token data');
                    _this.planProvider(token, function (planErr, plan) {
                        if (planErr) {
                            _this.log('err', 'Error trying to get user plan:');
                            _this.log('err', planErr.toString());
                            callback(planErr);
                        }
                        else {
                            if (_this.shouldCacheTokens) {
                                _this.redis.set(key, plan || 'none', function (err) {
                                    if (err) {
                                        _this.log('err', 'Error setting token plan in cache: ' + err);
                                    }
                                    else {
                                        _this.redis.expire(key, _this.cacheTtl);
                                    }
                                });
                            }
                            if (plan) {
                                _this.log('debug', 'Found plan: ' + plan + ' for token: ' + token);
                                var limits = _this.getPlanLimits(plan);
                                if (!limits) {
                                    _this.log('err', 'Plan ' + plan + ' is not defined?!');
                                    return _this.ipIsAllowed(ipAddress, callback);
                                }
                                else {
                                    _this.log('err', 'Plan ' + plan + ' has limits: ' + limits);
                                }
                                _this.lua.overLimitCheck(checkKey, limits, Guardini.now, 1, callback);
                            }
                            else {
                                //  Token failed, validate using ip and we're done here
                                _this.ipIsAllowed(ipAddress, callback);
                            }
                        }
                    });
                }
            }
        });
    };
    /**
     * Returns the plan limits of a given plan
     *
     * @param planName The plan name which is the actual key identifying the plan
     * @returns {Array|null}
     */
    Guardini.prototype.getPlanLimits = function (planName) {
        return (planName in this.options.plans) ? this.options.plans[planName].limits : null;
    };
    /**
     * A truthy return here indicates that no requests are allowed
     * with a missing token or an invalid one
     *
     * @returns {boolean}
     */
    Guardini.prototype.allowsGuests = function () {
        return ('free' in this.options.plans);
    };
    /**
     * Utility function used for logging things.
     *
     * @param type Log type
     * @param message Log message
     */
    Guardini.prototype.log = function (type, message) {
        if ('logger' in this.options) {
            return this.options['logger'](type, message);
        }
    };
    /**
     * Will load the lua scripts into redis
     */
    Guardini.prototype.loadScripts = function () {
        var _this = this;
        var overLimitCheck = fs.readFileSync(path.join(__dirname, 'guardini.lua'));
        return {
            overLimitCheck: function (key, limits, timestamp, weight, callback) {
                var data = { key: key, limits: limits, timestamp: timestamp, weight: weight };
                _this.scripty.loadScript('overLimitCheck', overLimitCheck, function (err, script) {
                    script.run(1, JSON.stringify(data), function (error, result) {
                        callback(error, result > 0);
                    });
                });
            }
        };
    };
    return Guardini;
}());
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Guardini;
