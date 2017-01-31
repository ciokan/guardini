[![CircleCI](https://circleci.com/gh/ciokan/guardini/tree/master.svg?style=svg)](https://circleci.com/gh/ciokan/guardini/tree/master)

## Introduction

Guardini is used in production at [infoip.io](https://infoip.io) and it has proven to be a reliable rate limiter so far.
It has some added functionality that makes it applicable to projects or websites that want to sell access to their APIs.

Guardini makes use of plans (payment plans if you wish) and is able to rate limit according to their specs allowing you
to sell different kinds of access to your API (have a look at the infoip [pricing page](http://www.infoip.io/pricing.html)).

## Dependencies

Guardini heavily depends on a Redis backend (this is the only requirement actually) and is tightly integrated with it. The
package injects a `lua` script into Redis in order to perform it's queries super fast without too much client-server communication
as opposed to other packages.

## Usage

The package is easy to setup and requires a minimum configuration to provide it's functionality. It tries to stay unopinionated
as much as possible without any requirements in regards to the framework you use. It is super easy to integrate as a middleware
in almost any nodejs web framework out there since it's only goal is to callback with a denied `true` or `false` parameter.

### Instance parameters

Guardini requires the following parameters:

- `redisClient connection`: A redis client connection
- `options`: Guardini options (see next section for details)
- `planProvider`: This is a method which Guardini will call whenever it receives a request to check a `token` that is not in it's
cache/database already. The package could be dumber than this and require that you pass a plan along with a token at each request
but this will greatly slow down your response time if you receive a lot of requests. To be as efficient as possible Guardini requests
the plan of a token only when it's not present in it's cache. So, this plan provider takes 2 parameters:
    - `token`: The token for which the provider should respond with a plan name
    - `callback`: A callback function which is used to pass back the plan

### Instance options

- `namespace`: optional namespace if you have multiple applications/endpoints with different plans and users are given the same token
- `plans`: object containing the plans (separation) with their limits. The plan name is represented by the keys you enter here
  - `limits`: Each plan should have a `limits` key with an array of of arrays with 2 values: the time interval (in seconds) for which
  the second value (the limit of requests in that interval) is allowed. The bigger the interval the longer you will have keys inside
  redis so it's advisable to keep the intervals small.
- `cacheInvalidateTtl`: Guardini is caching some results inside redis to avoid requesting the plan for each token at every request
in order to save time and resources. The length (in seconds) of this cache time should be added here. Default is `3600` seconds (one hour).

## An example is worth 1000 words

This example contains the plans that we use at infoip.io but everything has been simplified and made static so that you can understand
how it's supposed to work. You can use a mongo/mysql/etc database to query for the plans and then setup Guardini's options. The plan
provider should also make use of a database to lookup that `token` and see what plan it has.

#### Setup:
```javascript
const guard = new Guardini(redisClient, {
	namespace: 'infoip',
	plans: {
		free: {
			//	allows for 1 request per second and 1000/day for free users
			limits: [[1, 1], [86400, 1000]]
		},
		basic: {
			//	allows for 2 requests per second and 2000/day
			limits: [[1, 2], [86400, 2000]]
		},
		pro: {
			//	allows for 5 requests per second, 20000/day, 2,000,000/month
			//  this one will persist the keys for a longer period because
			//  of the 30 day period specified
			limits: [[1, 5], [86400, 20000], [86400 * 30, 2000000]]
		},
		mega: {
			//	allows for 20 requests per second and 80000/day
			limits: [[1, 20], [86400, 80000]]
		},
		ultra: {
			//	allows for 500 requests per second and 500000/day
			limits: [[1, 500], [86400, 500000]]
		}
	}
}, function planProvider(token, callback) {//	plan provider
	// this method should provide the plan of a token when requested
	// I highly encourage you to perform a database query here to retrieve
	// the plan of the provided token. This example is static in order to
	// better outline how the config should be done
	switch(token){
		case 'token-1234':
			return 'basic';
			break;
		case 'token-abcd':
			return 'ultra';
			break;
		default:
			return null;
	}
});
```

#### Call to check (expressjs example)

```javascript
router.get('/endpoint', (req, res) => {
	const clientIp = getClientIp(req);

	// token can be null in which case Guardini will check if there's
	// a free plan available and rate-limit based on the client ip
	const token = getToken(req);

	guardini.check(token, clientIp, (err, denied) => {
		if (err) {
			res.sendStatus(503);
		} else {
			if (denied) {
				res.sendStatus(429);
			} else {
				// client is allowed - respond here
			}
		}
	});
});
```

## Providing a free plan

It's crucial to be able to provide a free plan to any API and Guardini makes use of it. Simply specifying `free` as the plan key (as in the example above)
will enable a `freemium` type of rate-limit. If a client comes in without a token (or with invalid token) Guardini will look for this plan and, if available,
it will rate limit the requests based on the user ip address. If there is no `free` plan inside the `plans` definition then guardini will immediately
respond with a deny.

If you provide a free API but simply want to rate limit you can simply specify a `free` plan and Guardini will rate limit only based on ip address.