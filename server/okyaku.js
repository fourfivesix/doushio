var caps = require('./caps'),
    common = require('../common'),
    Muggle = require('../muggle').Muggle,
    STATE = require('./state'),
    winston = require('winston');

var dispatcher = exports.dispatcher = {};

function Okyaku(socket, ip) {
	this.socket = socket;
	this.ident = caps.lookup_ident(ip);
	this.watching = {};
}
exports.Okyaku = Okyaku;

var OK = Okyaku.prototype;

OK.send = function (msg) {
	this.socket.write(JSON.stringify([msg]));
};

OK.on_update = function (op, kind, msg) {
	// Special cases for operations that overwrite a client's state
	if (this.post && kind == common.DELETE_POSTS) {
		var nums = JSON.parse(msg)[0].slice(2);
		if (nums.indexOf(this.post.num) >= 0)
			this.post = null;
	}
	else if (this.post && kind == common.DELETE_THREAD) {
		if (this.post.num == op || this.post.op == op)
			this.post = null;
	}

	this.socket.write(msg);
};

OK.on_thread_sink = function (thread, err) {
	/* TODO */
	winston.error(thread, 'sank:', err);
};

OK.on_message = function (data) {
	var msg;
	try { msg = JSON.parse(data); }
	catch (e) {}
	var type = common.INVALID;
	if (msg) {
		if (this.post && typeof msg == 'string')
			type = common.UPDATE_POST;
		else if (msg.constructor == Array)
			type = msg.shift();
	}
	if (!this.synced && type != common.SYNCHRONIZE)
		type = common.INVALID;
	var func = dispatcher[type];
	if (!func || !func(msg, this)) {
		this.report(Muggle("Bad protocol.", new Error(
				"Invalid message: " + JSON.stringify(data))));
	}
};

OK.on_close = function () {
	if (this.id) {
		delete STATE.clients[this.id];
		this.id = null;
	}
	this.synced = false;
	var db = this.db;
	if (db) {
		db.kikanai();
		if (this.post)
			this.finish_post(function () {
				db.disconnect();
			});
		else
			db.disconnect();
	}
};

OK.report = function (error) {
	var msg = 'Server error.';
	if (error instanceof Muggle) {
		msg = error.most_precise_error_message();
		error = error.deepest_reason();
	}
	winston.error('Error by ' + JSON.stringify(this.ident) + ': '
			+ (error || msg));
	this.send([0, common.INVALID, msg]);
	this.synced = false;
};

OK.finish_post = function (callback) {
	/* TODO: Should we check this.uploading? */
	var self = this;
	this.db.finish_post(this.post, function (err) {
		if (err)
			callback(err);
		else {
			if (self.post) {
				self.last_num = self.post.num;
				self.post = null;
			}
			callback(null);
		}
	});
};
