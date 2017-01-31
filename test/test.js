/// <reference types="mocha" />
"use strict";
var index_1 = require('../index');
var chai = require('chai');
var redis = require('redis');
describe('Guardini', function () {
    var redisClient = redis.createClient(process.env.REDIS_SERVICE_PORT || 6379, process.env.REDIS_SERVICE_HOST || 'localhost');
    var GNoFree = new index_1.default(redisClient, {
        plans: {
            whatever: {
                limits: [[1, 2]]
            }
        }
    });
    var GFree = new index_1.default(redisClient, {
        plans: {
            free: {
                limits: [[1, 2]]
            }
        }
    });
    describe('check', function () {
        it('should not allow when free plan is not provided', function (done) {
            GNoFree.check(null, '192.168.1.1', function (err, denied) {
                if (err) {
                    done(err);
                }
                else {
                    chai.expect(denied).to.be.true;
                    done();
                }
            });
        });
        it('should call for the token plan provider when token is passed as argument', function (done) {
            var token = 'token123';
            var G = new index_1.default(redisClient, {
                plans: {
                    whatever: {
                        limits: [[1, 2]]
                    }
                }
            }, function (token, callback) {
                chai.expect(token).to.equal('token123');
                callback(null, null);
            });
            G.check(token, '192.168.1.1', function (err, denied) {
                chai.expect(denied).to.be.true;
                done();
            });
        });
        it('should abide plan limits', function (done) {
            var token = 'token1234';
            var G = new index_1.default(redisClient, {
                plans: {
                    whatever: {
                        limits: [[1, 1]]
                    }
                }
            }, function (token, callback) {
                chai.expect(token).to.equal('token1234');
                callback(null, 'whatever');
            });
            G.check(token, '192.168.1.1', function (err, denied) {
                chai.expect(denied).to.be.false;
                //  Second call should fail since the plan only allows 1req/s
                G.check(token, '192.168.1.1', function (err, denied) {
                    chai.expect(denied).to.be.true;
                    done();
                });
            });
        });
        it('should allow when free plan is provided', function (done) {
            GFree.check(null, '192.168.1.1', function (err, denied) {
                chai.expect(denied).to.be.false;
                //  Since we're here let's also test the limit
                GFree.check(null, '192.168.1.1', function (err, denied) {
                    chai.expect(denied).to.be.false;
                    // No more than 2 req/s so this one should
                    // fail since it's the third call
                    GFree.check(null, '192.168.1.1', function (err, denied) {
                        chai.expect(denied).to.be.true;
                        done();
                    });
                });
            });
        });
    });
});
