# Live Server Documentation

The current live socket server is at [https://repeater.esamarathon.com/](https://repeater.esamarathon.com/).

The server currently uses [socket.io](https://socket.io/), you will need to connect to it with something such as [socket.io-client](https://github.com/socketio/socket.io-client).

## Events

### `total`

Emitted when a donation's PayPal payment clears and the overall donation total increases.

Key | Type | Description
--- | ---- | -----------
event | string | Shorthand event string this total is for.
id | integer | Unique donation ID from the database.
amount | string | The amount this donation is for. Currency isn't specified but is (currently) USD.
new_total | string | The new overall donation total. Currency isn't specified but is (currently) USD.

##### Example Object

```
{ event: '2018s1', id: 27, amount: '5.00', new_total: '921.99' }
```

### `donation`

Emitted when a donation should be shown to the public on the stream. Currently this is when it's either read by a host or has been accepted but is not going to sent to the hosts.

Key | Type | Description
--- | ---- | -----------
event | string | Shorthand event string this donation is for.
id | integer | Unique donation ID from the database.
donor_visiblename | string | The name of the donor that they would like to appear as publicly (can be `(Anonymous)`).
amount | string | The amount this donation is for. Currency isn't specified but is (currently) USD.
comment_state | string | If the donation comment was accepted/rejected. *Should* be `APPROVED` or `DENIED`, rarely could be something else if something server side messes up; treat anything that isn't `APPROVED` as if it was `DENIED`.
comment | string | Donator's comment. Can be blank; is made blank if their comment was rejected.
time_received | string | Time stamp of when the donation was received.

##### Example Object

```
{ event: '2018s2',
  id: 1,
  donor_visiblename: 'tester123',
  amount: '5.00',
  comment_state: 'APPROVED',
  comment: 'zoton2\'s test donation',
  time_received: '2018-02-04 16:18:01+00:00' }
```
