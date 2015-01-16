'use strict';

var heapdump = require('heapdump');
var pomelo = require('pomelo');

var app = pomelo.createApp();
app.set('name', 'quick-pomelo');

// configure for global
app.configure('all', function() {

	app.enable('systemMonitor');

	// rpc client configurations
	app.set('proxyConfig', {
		cacheMsg : true,
		interval : 30,
		lazyConnection : true,
		timeout : 10 * 1000,
		failMode : 'failfast',
	});

	app.set('remoteConfig', {
		cacheMsg : true,
		interval : 30,
		timeout : 10 * 1000,
	});

	// Configure Redis
	// app.loadConfig('redis', app.getBase() + '/config/redis.json');
	// require('./app/redis').init(app.get('redis'));
});

//Connector settings
app.configure('all', 'gate|connector', function() {
	app.set('connectorConfig', {
		connector : pomelo.connectors.hybridconnector,
		heartbeat : 30,
	});

	app.set('sessionConfig', {
		singleSession : true,
	});
});

process.on('uncaughtException', function(err) {
	console.error('Uncaught exception: ', err);
});

app.start();