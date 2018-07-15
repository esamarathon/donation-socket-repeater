// Referencing modules.
const fs = require('fs-extra');
const app = require('express')();
const server = require('http').Server(app);
const bodyParser = require('body-parser');
const io = require('socket.io')(server);

// Loading config.
var config = fs.readJsonSync('./config.json', {throws:false});
if (!config) {
	console.log('You have forgotten the config.json file; using defaults.');
}

// Set port/key shorthand here; defaults if the config doesn't have it set.
var port = (config) ? config.port : 1234;
var key = (config) ? config.key : 'default_key';

// Starting server.
app.use(bodyParser.json());
server.listen(port);
console.log(`Listening on port ${port}.`);

// Storage for stream information to send to clients.
var streamInfo = {
	stream1: null,
	stream2: null
}

// Emit stream information to clients when they connect.
io.on('connection', (socket) => {
	console.log('Client connected with ID %s', socket.id);
	socket.emit('streamInfo', streamInfo);
});

// A GET in case you need to check the server is running.
app.get('/', (req, res) => {
	res.send('Running OK');
});

// This is where the tracker postbacks are received.
app.post('/tracker', (req, res) => {
	// Reject POSTs without the correct key.
	if (req.query.key !== key) {
		res.sendStatus(403);
		return;
	}
	
	// Donation pushes, from when they are approved to be shown on stream.
	if (req.body.message_type === 'donation_push') {
		// Remove the comment if it wasn't approved.
		if (req.body.comment_state !== 'APPROVED')
			req.body.comment = '';
		
		// Constructing the data to be sent.
		var data = {
			event: req.body.event,
			id: req.body.id,
			donor_visiblename: req.body.donor_visiblename,
			amount: req.body.amount,
			comment_state: req.body.comment_state,
			comment: req.body.comment,
			time_received: req.body.time_received
		};
		
		// Emit this data over the sockets.
		io.emit('donation', data);
		console.log('EMIT donation:', data);
	}
	
	// Donation total change, when the total goes up when a payment is confirmed.
	else if (req.body.message_type === 'donation_total_change') {
		// Constructing the data to be sent.
		var data = {
			event: req.body.event,
			id: req.body.id,
			amount: req.body.amount,
			new_total: req.body.new_total
		};
		
		// Emit this data over the sockets.
		io.emit('total', data);
		console.log('EMIT total:', data);
	}
	
	res.sendStatus(200);
});

// POSTS to here from streams on what their current run is.
app.post('/stream_info', (req, res) => {
	// Reject POSTs without the correct key.
	if (req.query.key !== key) {
		res.sendStatus(403);
		return;
	}
	
	// Store the data in the correct place.
	if (req.body.stream === 1)
		streamInfo.stream1 = req.body.runData;
	else if (req.body.stream === 2)
		streamInfo.stream2 = req.body.runData;

	// Emit this information now that it's changed.
	io.emit('streamInfo', streamInfo);
	console.log('EMIT streamInfo:', streamInfo);
	res.sendStatus(200);
});

// POSTS to here from the omnibar moderation tool.
app.post('/omnibar_mod', (req, res) => {
	// Reject POSTs without the correct key.
	if (req.query.key !== key) {
		res.sendStatus(403);
		return;
	}

	// Return a 400 if the body is not supplied.
	if (!req.body) {
		res.sendStatus(400);
		return;
	}

	// Emit this information.
	io.emit('omnibarMod', req.body);
	console.log('EMIT omnibarMod:', req.body);
	res.sendStatus(200);
});

// GETs to here return the stream information, if needed.
app.get('/stream_info', (req, res) => {
	res.json(streamInfo);
});