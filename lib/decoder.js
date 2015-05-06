/*jslint node: true, vars: true, nomen: true */
'use strict';

var debug = require('debug')('ebml:decoder');
var fs = require('fs');
var SlowBuffer = require('buffer').SlowBuffer;
var util = require('util');
var Writable = require('stream').Writable;

var Document2 = require('./document2');
var FileSource = require('./fileSource');
// var Tag = require('./element');
var tools = require('./tools');
var schema = require('./schema');

var STATE_TAG = 1;
var STATE_SIZE = 2;
var STATE_CONTENT = 3;
var SKIP_DATA = 4;

var LOG = true;

function EbmlDecoder(options) {

	Writable.call(this, options);

	options = options || {};
	this.options = options;

	this.skipTags = options.skipTags;
	if (this.skipTags === undefined) {
		this.skipTags = {
			SimpleBlock: true,
			Void: true,
			Block: true,
			FileData: true,
			TagBinary: true
		};
	}

	this.ignoreData = options.ignoreData;
	this._buffer = null;
	this._tag_stack = [];
	this._state = STATE_TAG;
	this._bufferOffset = 0;
	this._fileOffset = 0;
	this._tagVint = {};
	this._workingBuffer = new Buffer(64);
	this.document = new Document2();

	this._skipTagData = (this.ignoreData === true); // Stream mode (default mode)
	// this.ignoreData = false;

	var self = this;
	this.on('finish', function() {

		self.document._buildLinks();

		self.emit("$document", self.document);
	});
}

module.exports = EbmlDecoder;

util.inherits(EbmlDecoder, Writable);

EbmlDecoder.OnlyMetaDatas = function() {
	return {
		skipTags: {
			SimpleBlock: true,
			Void: true,
			Block: true,
			FileData: true,
			Cluster: true,
			Cues: true,
			Tracks: true
		}
	};
};

EbmlDecoder.AllDatas = function() {
	return {
		skipTags: {}
	};
};

EbmlDecoder.prototype.parseFile = function(filename, callback) {
	if (this.document.children) {
		return callback(new Error("Document has already children"));
	}

	this.document.source = new FileSource(filename);

	this._skipTagData = (this.ignoreData === true);
	this._reuseBuffer = true;

	this._readOffset = 0;
	var blockSize = (this.skipTags) ? (1024 * 4) : (1024 * 64);

	var self = this;

	var buffer = new Buffer(blockSize);

	var fd;
	function read() {
		if (self._stop) {
			return callback(null, null);
		}

		if (!self._reuseBuffer) {
			buffer = new Buffer(blockSize);
		}

		fs.read(fd, buffer, 0, buffer.length, self._readOffset, function(error, bytesRead, buffer) {
			if (error) {
				fs.close(fd);
				return callback(error);
			}

			if (!bytesRead) {
				fs.close(fd);

				self.document._buildLinks();
				return callback(null, self.document);
			}

			if (bytesRead < buffer.length) {
				buffer = buffer.slice(0, bytesRead);
			}

			self._readOffset += bytesRead;
			self._write(buffer, null, function() {
				if (self._skipBytes) {
					self._readOffset += self._skipBytes;
					self._fileOffset += self._skipBytes;
					self._skipBytes = 0;
				}

				setImmediate(read);
			});
		});
	}

	fs.open(filename, 'r', function(error, fd1) {
		if (error) {
			return callback(error);
		}

		fd = fd1;
		read();
	});
};

EbmlDecoder.prototype._write = function(chunk, enc, done) {

	if (this._state === SKIP_DATA) {
		if (this._skipBytes >= chunk.length) {
			this._skipBytes -= chunk.length;
			this._fileOffset += chunk.length;
			this._bufferOffset = 0;
			chunk = null;

		} else {
			this._fileOffset += this._skipBytes;
			this._bufferOffset = this._skipBytes;
			this._skipBytes = 0;
		}

		if (!this._skipBytes) {
			if (this._skipEndFunc) {
				this._skipEndFunc();
				this._skipEndFunc = null;
			}
			this._state = STATE_TAG;
		}

		if (!chunk || !chunk.length) {
			done();
			return;
		}
		this._buffer = null;
	}

	var shared = true;
	if (!this._buffer) {
		this._buffer = chunk;
	} else {
		shared = false;
		this._buffer = Buffer.concat([ this._buffer, chunk ]);
	}

	while (!this._stop && this._buffer && this._bufferOffset < this._buffer.length) {

		if (this._state === STATE_TAG) {
			if (!this.readTag()) {
				break;
			}
			continue;
		}

		if (this._state === STATE_SIZE) {
			if (!this.readSize()) {
				break;
			}

			continue;
		}

		if (this._state === STATE_CONTENT) {
			if (!this.readContent()) {
				break;
			}

			continue;
		}
		if (this._state === SKIP_DATA) {
			break;
		}

		console.error("Invalid state ", this._state);
	}

	if (this._buffer) {
		if (this._bufferOffset === this._buffer.length) {
			this._buffer = null;
			this._bufferOffset = 0;

		} else if (shared && this._reuseBuffer) {

			var left = this._buffer.length - this._bufferOffset;

			if (this._workingBuffer && this._workingBuffer.length >= left) {
				this._buffer.copy(this._workingBuffer, 0, this._bufferOffset);
				this._buffer = this._workingBuffer.slice(0, left);
				// console.log("Use working " + left);

			} else if (this._useSlowBuffer && this._skipTagData) {
				var sb = new SlowBuffer(left);
				this._buffer.copy(sb, 0, this._bufferOffset);
				this._buffer = sb;

			} else {
				var buf = this._buffer.slice(this._bufferOffset);
				this._buffer = new Buffer(buf);
			}

			this._bufferOffset = 0;
		}
	}

	done();
};

EbmlDecoder.prototype.readTag = function() {

	debug('parsing tag');

	var start = this._fileOffset;
	var tag;
	try {
		tag = tools.readHInt(this._buffer, this._bufferOffset, this._tagVint);
	} catch (x) {
		console.error(x);
		throw x;
	}

	if (tag === null) {
		debug('waiting for more data');
		return false;
	}

	this._bufferOffset += tag.length;
	this._fileOffset += tag.length;
	this._state = STATE_SIZE;

	var stack = this._tag_stack;

	var parent;
	if (stack.length) {
		parent = stack[stack.length - 1];
	}

	var tagObj = this.document.createElement(tag.value, start, tag.length);

	(parent || this.document).appendChild(tagObj, false);

	stack.push(tagObj);

	// console.log("Read tag " + tagObj.name);

	if (LOG) {
		debug('read tag: ' + util.inspect(tagObj, {
			depth: 1
		}));
	}

	return true;
};

EbmlDecoder.prototype.readSize = function() {

	var stack = this._tag_stack;
	var tagObj = stack[this._tag_stack.length - 1];

	if (LOG) {
		debug('parsing size for tag: ' + tagObj.ebmlID.toString(16));
	}

	var size = tools.readVInt(this._buffer, this._bufferOffset, this._tagVint);

	if (size === null) {
		debug('waiting for more data');
		return false;
	}

	if (size.value < 0) {
		throw new Error("Invalid size " + size.value + " cursor=" + this._bufferOffset + " buffer=" + this._buffer.length);
	}

	this._bufferOffset += size.length;
	this._fileOffset += size.length;
	this._state = STATE_CONTENT;
	tagObj._setDataSize(size.value, size.length);

	if (LOG) {
		debug('read size: ' + size.value);
	}

	if (size.value === 0) {
		return this.endContent(tagObj);
	}

	return true;
};

EbmlDecoder.prototype.readContent = function() {

	var stack = this._tag_stack;

	var tag = stack[stack.length - 1];

	if (LOG) {
		debug('parsing content for tag: ' + tag.ebmlID.toString(16));
	}

	if (tag.masterType) {
		if (LOG) {
			debug('content should be tags');
		}

		// console.log("start tag " + tag.name);
		this.emit(tag.name, tag);
		this._state = STATE_TAG;

		if (this.skipTags && this.skipTags[tag.name]) {

			stack.pop(); // remove the object from the stack

			var leftBytes = this._buffer.length - this._bufferOffset;

			var contentBytes = tag.end - this._fileOffset;

			// console.log("Seek start=" + this._fileOffset + " content=" +
			// contentBytes +
			// "
			// left=" + leftBytes);

			if (contentBytes >= leftBytes) {
				this._skipBytes = contentBytes - leftBytes;
				this._fileOffset += leftBytes;
				this._buffer = null;
				this._bufferOffset = 0;
				this._state = SKIP_DATA;
				return false;
			}

			this._bufferOffset += contentBytes;
			this._fileOffset += contentBytes;

			return true;
		}

		return true;
	}

	var leftBytes = this._buffer.length - this._bufferOffset;

	if (leftBytes < tag.dataSize) {
		if (LOG) {
			debug('got: ' + leftBytes);
			debug('need: ' + (tag.dataSize - leftBytes));
			debug('waiting for more data');
		}

		if (this._skipTagData) {
			this._skipBytes = tag.dataSize - leftBytes;
			this._fileOffset += leftBytes;
			this._buffer = null;
			this._bufferOffset = 0;
			this._state = SKIP_DATA;

			this._skipEndFunc = this.endContent.bind(this, tag);
		}

		return false;
	}

	if (!this.ignoreData && (!this.skipTags || !this.skipTags[tag.name])) {
		var data = this._buffer.slice(this._bufferOffset, this._bufferOffset + tag.dataSize);
		if (this._reuseBuffer) {
			data = new Buffer(data);
		}
		tag._setData(data);

	}

	this._fileOffset += tag.dataSize;
	this._buffer = this._buffer.slice(this._bufferOffset + tag.dataSize);
	this._bufferOffset = 0;

	return this.endContent(tag);
};

EbmlDecoder.prototype.endContent = function(tagObj) {

	var stack = this._tag_stack;

	stack.pop(); // remove the object from the stack

	while (stack.length) {
		var topEle = stack[stack.length - 1];
		if (this._fileOffset < topEle.end) {
			break;
		}
		this.emit(topEle.name + ':end', topEle);
		stack.pop();
	}

	this.emit(tagObj.name, tagObj);

	if (LOG) {
		debug('read data: ' + (tagObj.data && tagObj.data.toString('hex')));
	}

	this._state = STATE_TAG;

	return true;
};

EbmlDecoder.prototype.parseFileSection = function(path, ebmlIDs, callback) {

	if (!util.isArray(ebmlIDs)) {
		ebmlIDs = [ ebmlIDs ];
	}

	var self = this;
	var segmentContentPosition;
	var toParse = [];
	var targets = {};

	var positions = [];

	function nextPosition() {

		if (!positions.length) {
			self._stop = true;
			return;
		}

		var position = positions.shift();

		var newOffset = segmentContentPosition + position;

		// console.log("New offset=" + newOffset, tag.getLevel1().getPosition(),
		// tag.getLevel1().getContentPosition(),tag.seekPosition);

		self._readOffset = newOffset;
		self._fileOffset = newOffset;
		self._buffer = null;
		self._bufferOffset = 0;
		self._skipBytes = 0;
		self._state = STATE_TAG;
	}

	ebmlIDs.forEach(function(name) {
		var ebmlID = tools.convertEbmlID(name);

		if (toParse.indexOf(ebmlID) >= 0) {
			return;
		}

		toParse.push(ebmlID);

		var ebmlName = schema.byEbmlID[ebmlID].name;
		self.on(ebmlName, function(tag) {
			targets[tag.ebmlID] = tag;
		});
		self.on(ebmlName + ":end", function(tag) {
			nextPosition();
		});
	});

	this.on("Seek:end", function(tag) {
		var sid = tag.seekID;

		if (toParse.indexOf(sid) < 0) {
			return;
		}
		positions.push(tag.seekPosition);
	});

	this.on("SeekHead:end", function(seekHead) {
		segmentContentPosition = seekHead.getLevel1().getContentPosition();

		positions.sort(function(v1, v2) {
			return v1 - v2;
		});

		nextPosition();
	});

	this.parseFile(path, function(error, document) {
		if (error) {
			return callback(error);
		}

		// console.log("Target=", target.print());
		self.document_partial = true;

		callback(null, self.document, targets);
	});
};