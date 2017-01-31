/// <reference types="mocha" />

import Guardini from '../index';

const chai = require('chai');
const redis = require('redis');

describe('Guardini', () => {
    const redisClient = redis.createClient(
        process.env.REDIS_SERVICE_PORT || 6379,
        process.env.REDIS_SERVICE_HOST || 'localhost'
    );

    const GNoFree = new Guardini(redisClient, {
        plans: {
            whatever: {
                limits: [[1, 2]]
            }
        }
    });

    const GFree = new Guardini(redisClient, {
        plans: {
            free: {
                limits: [[1, 2]]
            }
        }
    });

    describe('check', () => {
        it('should not allow when free plan is not provided', (done) => {
            GNoFree.check(null, '192.168.1.1', (err, denied) => {
                if (err) {
                    done(err);
                } else {
                    chai.expect(denied).to.be.true;
                    done();
                }
            });
        });

        it('should call for the token plan provider when token is passed as argument', (done) => {
            let token = 'token123';
            let G = new Guardini(redisClient, {
                plans: {
                    whatever: {
                        limits: [[1, 2]]
                    }
                }
            }, (token, callback) => {//	plan provider
                chai.expect(token).to.equal('token123');
                callback(null, null);
            });

            G.check(token, '192.168.1.1', (err, denied) => {
                chai.expect(denied).to.be.true;
                done();
            });
        });

        it('should abide plan limits', (done) => {
            let token = 'token1234';
            let G = new Guardini(redisClient, {
                plans: {
                    whatever: {
                        limits: [[1, 1]]
                    }
                }
            }, (token, callback) => {//	plan provider
                chai.expect(token).to.equal('token1234');
                callback(null, 'whatever');
            });

            G.check(token, '192.168.1.1', (err, denied) => {
                chai.expect(denied).to.be.false;

                //  Second call should fail since the plan only allows 1req/s
                G.check(token, '192.168.1.1', (err, denied) => {
                    chai.expect(denied).to.be.true;
                    done();
                });
            });
        });

        it('should allow when free plan is provided', (done) => {
            GFree.check(null, '192.168.1.1', (err, denied) => {
                chai.expect(denied).to.be.false;

                //  Since we're here let's also test the limit
                GFree.check(null, '192.168.1.1', (err, denied) => {
                    chai.expect(denied).to.be.false;

                    // No more than 2 req/s so this one should
                    // fail since it's the third call
                    GFree.check(null, '192.168.1.1', (err, denied) => {
                        chai.expect(denied).to.be.true;
                        done();
                    });
                });
            });
        });
    });
});