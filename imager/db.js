var cache = require('../server/state').dbCache,
    events = require('events'),
    fs = require('fs'),
    Muggle = require('../muggle').Muggle,
    tail = require('../tail'),
    util = require('util'),
    winston = require('winston');

var IMG_EXPIRY = 20;

function Onegai() {
	events.EventEmitter.call(this);
}

util.inherits(Onegai, events.EventEmitter);
exports.Onegai = Onegai;
var O = Onegai.prototype;

O.connect = function () {
	return cache.sharedConnection;
};

O.disconnect = function () {};

O.track_temporaries = function (adds, dels, callback) {
	var m = this.connect().multi();
	var cleans = cache.imageAllocCleanups;
	var self = this;
	if (adds && adds.length) {
		m.sadd('temps', adds);
		adds.forEach(function (add) {
			cleans[add] = setTimeout(
				self.cleanup_image_alloc.bind(self, add),
				(IMG_EXPIRY+1) * 1000);
		});
	}
	if (dels && dels.length) {
		m.srem('temps', dels);
		dels.forEach(function (del) {
			if (del in cleans) {
				clearTimeout(cleans[del]);
				delete cleans[del];
			}
		});
	}
	m.exec(callback);
};

// if an image doesn't get used in a post in a timely fashion, delete it
O.cleanup_image_alloc = function (path) {
	delete cache.imageAllocCleanups[path];
	var r = this.connect();
	r.srem('temps', path, function (err, n) {
		if (err)
			return winston.warn(err);
		if (n)
			fs.unlink(path);
	});
};

// catch any dangling images on server startup
O.delete_temporaries = function (callback) {
	var r = this.connect();
	r.smembers('temps', function (err, temps) {
		if (err)
			return callback(err);
		tail.forEach(temps, function (temp, cb) {
			fs.unlink(temp, function (err) {
				if (err)
					winston.warn('temp: ' + err);
				else
					winston.info('del temp ' + temp);
				cb(null);
			});
		}, function (err) {
			if (err)
				return callback(err);
			r.del('temps', callback);
		});
	});
};

O.check_duplicate = function (hash, callback) {
	this.connect().get('hash:'+hash, function (err, num) {
		if (err)
			callback(err);
		else if (num)
			callback(Muggle('Duplicate of >>' + num + '.'));
		else
			callback(false);
	});
};

O.record_image_alloc = function (id, alloc, callback) {
	var r = this.connect();
	r.setex('image:' + id, IMG_EXPIRY, JSON.stringify(alloc), callback);
};

O.obtain_image_alloc = function (id, callback) {
	var m = this.connect().multi();
	var key = 'image:' + id;
	m.get(key);
	m.setnx('lock:' + key, '1');
	m.expire('lock:' + key, IMG_EXPIRY);
	m.exec(function (err, rs) {
		if (err)
			return callback(err);
		if (rs[1] != 1)
			return callback(Muggle("Image in use."));
		if (!rs[0])
			return callback(Muggle("Image lost."));
		var alloc = JSON.parse(rs[0]);
		alloc.id = id;
		callback(null, alloc);
	});
};

exports.make_image_nontemporary = function (m, alloc) {
	// We should already hold the lock at this point.
	var key = 'image:' + alloc.id;
	m.del(key);
	m.del('lock:' + key);
	var cleans = cache.imageAllocCleanups;
	alloc.paths.forEach(function (path) {
		if (path && path in cleans) {
			clearTimeout(cleans[path]);
			delete cleans[path];
			m.srem('temps', path);
		}
	});
};

O.client_message = function (client_id, msg) {
	this.connect().publish('client:' + client_id, JSON.stringify(msg));
};

O.relay_client_messages = function () {
	var r = require('../db').redis_client();
	r.psubscribe('client:*');
	var self = this;
	r.once('psubscribe', function () {
		self.emit('relaying');
		r.on('pmessage', function (pat, chan, message) {
			var id = parseInt(chan.match(/^client:(\d+)$/)[1], 10);
			self.emit('message', id, JSON.parse(message));
		});
	});
};
