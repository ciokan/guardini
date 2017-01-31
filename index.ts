/// <reference types="redis" />
/// <reference types="node" />

import fs = require("fs");
import path = require("path");
import {RedisClient} from "redis";

const Scripty = require('node-redis-scripty');


export default class Guardini {
    redis: RedisClient;
    options: {
        namespace: string,
        cacheInvalidateTtl: number,
        plans: {
            name: {
                limits: Array<[Array<[number, number]>]>
            }
        }
    };
    planProvider: (token: string, callback: (error: string, plan: string) => void) => void;
    lua: {
        overLimitCheck: (key: string, limits: Array<[Array<[number, number]>]>, timestamp: number, weight: number, callback: (err: string, denied: boolean) => void) => void
    };

    scripty: any;

    /**
     * Constructor for the rate limiter class
     *
     * @param redisClient: The redis connection that we use
     * @param options: Object containing global options:
     *      - plans: array of plan objects
     *          - name: the plan name
     *          - limit: what is the plan limit in seconds
     * @param planProvider A method that provides a user plan based
     *      on supplied token. We use this only when we don't know the user
     *      plan based on history in order to avoid checking it on every request
     *      and keep our resource usage as low as possible. If there are no plans
     *      set this method will not be called and we will attempt to limit based
     *      on global limits configured. If no global limits are configured, the
     *      request will be accepted. As a matter of fact, without a global limit,
     *      all requests are accepted by default so keep that in mind.
     */
    constructor(redisClient, options, planProvider?) {
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
    public check(token: string, ipAddress: string, callback) {
        //	Check if `tokenIsRequired` and reject the request
        //	if it's required but no token was provided by caller
        if (!this.allowsGuests() && !token) {
            return callback(null, true);
        }

        if (token) {
            this.isTokenAllowed(token, ipAddress, callback);
        } else {
            this.ipIsAllowed(ipAddress, callback);
        }
    }

    /**
     * Returns the current namespace that our instance runs under
     * We use namespaces to separate projects or differentiate
     * api gateways with different plans
     *
     * @returns {string}
     */
    private get namespace() {
        return ('namespace' in this.options) ? this.options['namespace'] : '';
    }

    /**
     * Returns the number of seconds indicating the cache interval
     * for tokens to avoid calling the `planProvider` method too much.
     * Results are cached in redis for this time period. Default is set
     * at 3600 seconds (1 hour)
     *
     * @returns {number}
     */
    private get cacheTtl() {
        return ('cacheInvalidateTtl' in this.options) ? this.options['cacheInvalidateTtl'] : 3600;
    }

    /**
     * Returns true or false which indicates wether we should cache
     * token responses inside redis or not. Without caching, redis will
     * call the `planProvider` method on every request so I highly recommend
     * on enabling this one.
     *
     * @returns {boolean}
     */
    private get shouldCacheTokens() {
        return this.cacheTtl > 0;
    }

    /**
     * Utility function that returns the current unix timestamp
     * to be sent over to the lua script inside Redis
     *
     * @returns {number}
     */
    private static get now() {
        return Math.round(new Date().getTime() / 1000);
    }

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
    private ipIsAllowed(ipAddress: string, callback) {
        if (!this.allowsGuests()) {
            return callback(null, true);
        }

        const limits = this.options.plans['free'].limits;
        const key = `rl:hit:${ipAddress}`;

        this.lua.overLimitCheck(key, limits, Guardini.now, 1, callback);
    }

    private isTokenAllowed(token: string, ipAddress: string, callback) {
        // This key holds the token plan
        const key = `${this.namespace}:rl:${token}`;
        // This key holds the token counter/usage
        const checkKey = `${this.namespace}:rl:hit:${token}`;

        //  Try to retrieve the user plan from Redis
        this.redis.get(key, (error, plan) => {
            if (error) {
                this.log('err', error.toString());
                return callback(error);
            } else {
                if (plan) {
                    this.log('debug', 'User plan found in cache: ' + plan);

                    if (plan == 'none') {
                        return this.ipIsAllowed(ipAddress, callback);
                    }

                    const limits = this.getPlanLimits(plan);

                    this.log('debug', 'Limits for ' + plan + ': ' + limits);

                    if (limits) {
                        this.lua.overLimitCheck(checkKey, limits, Guardini.now, 1, callback);
                    } else {
                        //  Plan was not found so delete this key so we can refresh our db
                        this.redis.del(key);

                        return this.ipIsAllowed(ipAddress, callback);
                    }
                } else {
                    if (this.planProvider === undefined) {
                        this.log('warn', 'No user plans defined');

                        //  No plan provider...check the ip method
                        return this.ipIsAllowed(ipAddress, callback);
                    }

                    this.log('debug', 'Will check plan provider for token data');
                    this.planProvider(token, (planErr, plan) => {
                        if (planErr) {
                            this.log('err', 'Error trying to get user plan:');
                            this.log('err', planErr.toString());

                            callback(planErr);
                        } else {
                            if (this.shouldCacheTokens) {
                                this.redis.set(key, plan || 'none', (err) => {
                                    if (err) {
                                        this.log('err', 'Error setting token plan in cache: ' + err);
                                    } else {
                                        this.redis.expire(key, this.cacheTtl);
                                    }
                                });
                            }

                            if (plan) {
                                this.log('debug', 'Found plan: ' + plan + ' for token: ' + token);

                                const limits = this.getPlanLimits(plan);

                                if (!limits) {
                                    this.log('err', 'Plan ' + plan + ' is not defined?!');

                                    return this.ipIsAllowed(ipAddress, callback);
                                } else {
                                    this.log('err', 'Plan ' + plan + ' has limits: ' + limits);
                                }

                                this.lua.overLimitCheck(checkKey, limits, Guardini.now, 1, callback);
                            } else {
                                //  Token failed, validate using ip and we're done here
                                this.ipIsAllowed(ipAddress, callback);
                            }
                        }
                    });
                }
            }
        });
    }

    /**
     * Returns the plan limits of a given plan
     *
     * @param planName The plan name which is the actual key identifying the plan
     * @returns {Array|null}
     */
    private getPlanLimits(planName: string): Array<[Array<[number, number]>]> {
        return (planName in this.options.plans) ? this.options.plans[planName].limits : null;
    }

    /**
     * A truthy return here indicates that no requests are allowed
     * with a missing token or an invalid one
     *
     * @returns {boolean}
     */
    private allowsGuests() {
        return ('free' in this.options.plans);
    }

    /**
     * Utility function used for logging things.
     *
     * @param type Log type
     * @param message Log message
     */
    private log(type: string, message: string) {
        if ('logger' in this.options) {
            return this.options['logger'](type, message);
        }
    }

    /**
     * Will load the lua scripts into redis
     */
    private loadScripts() {
        const overLimitCheck = fs.readFileSync(path.join(
            __dirname, 'guardini.lua'
        ));

        return {
            overLimitCheck: (key, limits, timestamp, weight, callback) => {
                const data = {key, limits, timestamp, weight};
                this.scripty.loadScript('overLimitCheck', overLimitCheck, (err, script) => {
                    script.run(1, JSON.stringify(data), (error, result) => {
                        callback(error, result > 0)
                    });
                });
            }
        }
    }
}