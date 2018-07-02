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

// A GET in case you need to check the server is running.
app.get('/', (req, res) => {
	res.send('Running OK');
});

// This is where the postbacks are received.
app.post('/', (req, res) => {
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