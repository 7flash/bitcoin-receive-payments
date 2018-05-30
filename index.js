var EventEmitter = require('events').EventEmitter;
var BLT = require("bitcoin-live-transactions")
var bitcore = require('bitcore-lib');
var HDPublicKey = bitcore.HDPublicKey;
var Address = bitcore.Address;
var Networks = bitcore.Networks;
var seconds_in_cache_15 = 60 * 15
var seconds_in_cache_14 = 60 * 14
var seconds_in_cache_10 = 60 * 10
var seconds_in_cache_5 = 60 * 5
var redis = require('redis');
var max_gap = 15
var debugbrp = require('debug')('brp')
var debugaddress = require('debug')('brp:address')
var randomstring = require('randomstring')
var client;
// var env = process.env.NODE_ENV || 'development';
// var config = require('./config')[env];
// require('./config/mongoose')(config);
// client.flushdb()

module.exports = Gateway

var set_address_in_use = function(address, id, rawid) {
  return new Promise(function(Success, R) {
    client.set('address-' + address, id, function(err, reply) {
      //   debugaddress(err, reply)
      client.expireat('address-' + address, parseInt((+new Date) / 1000) + seconds_in_cache_15); // delete after 15 minutes
    });
    client.set('rawid-address-' + address, rawid, function(err, reply) {
      //   debugaddress(err, reply)
      client.expireat('address-' + address, parseInt((+new Date) / 1000) + seconds_in_cache_15); // delete after 15 minutes
    });
    client.set('address-expiration-' + address, parseInt((+new Date) / 1000) + seconds_in_cache_15, function(err, reply) {
      //   debugaddress(err, reply)
      client.expireat('address-' + address, parseInt((+new Date) / 1000) + seconds_in_cache_15); // delete after 15 minutes
    });
    client.set('id-' + id, address, function(err, reply) {
      //   debugaddress(err, reply)
      client.expireat('id-' + id, parseInt((+new Date) / 1000) + seconds_in_cache_10);
      Success(reply)
    });
  })
}
var seconds_left_for_address = function(address) {
  return new Promise(function(Success, Reject) {
    client.get('address-expiration-' + address, function(err, reply) {

      if (reply != undefined) {
        Success(reply)
      } else {
        Reject();
      }
    });
  })
}

var id_has_address_assigned = function(id) {
  return new Promise(function(Success, Reject) {
    client.get('id-' + id, function(err, reply) {
      if (reply === null) {
        Reject();
      } else {
        Success(reply)
      }
    });
  })
}

var id_assigned_to_address = function(address) {
  return new Promise(function(Success, Reject) {
    client.get('rawid-address-' + address, function(err, reply) {
      if (reply === null) {
        Reject();
      } else {
        Success(reply)
      }
    });
  })
}

var is_address_available = function(address, id, rawid) {
  return new Promise(function(Success, Reject) {
    client.get('address-' + address, function(err, reply) {
      if (reply == undefined) {
        set_address_in_use(address, id, rawid).then(function() {
          Success(address)
        })
      } else {
        Reject(address);
      }
    });
  })
}


var generate_key = function() {
  return randomstring.generate({
    length: 14,
    charset: 'abcdefghijklmnpqrstuvwxyz1234567890'
  });
}

function Gateway(xpub, redisOptions) {
  var self = this
  this.ies = {}
  if (!(self instanceof Gateway)) return new Gateway(xpub, redisOptions)
  this.xpub = xpub
  this.unused_addresses = []
  this.addresses_count = 0
  this.events = new EventEmitter()

  client = redis.createClient(redisOptions ? redisOptions : {});

  this.retrieved = new HDPublicKey(this.xpub)
  var bitcoin = new BLT()

  this.uBTCtoSAT = function(amount) {
    return amount * 100
  }

  this.SATtouBTC = function(amount) {
    return amount / 100
  }

  this.received_payment = function(payment, xpubinfo, initializedCallback) {
    // self.forgetAddress(payment.address, xpubinfo, initializedCallback)
    id_assigned_to_address(payment.address).then(function(id) {
      payment.id = id
      self.events.emit('payment', payment)
      self.events.emit(payment.address, payment)
      self.forgetAddress(payment.address, xpubinfo, initializedCallback)
    }, function() {
      self.events.emit('payment', payment)
      self.events.emit(payment.address, payment)
      self.forgetAddress(payment.address, xpubinfo, initializedCallback)
    })
  }

  this.forgetAddress = function(address, xpubinfo, initializedCallback) {
    // debugaddress('ADDRESS USED:', address.toString())
    client.lrem('available-addresses' + xpubinfo._id, 0, address.toString());
    client.sadd('used-addresses' + xpubinfo._id, address.toString());
    client.get('address-' + address, function(err, reply) {
      if (reply != null) {
        client.del('id-' + reply)
      }
    });
    self.checkAddress(xpubinfo, self.ies[xpubinfo._id], initializedCallback)
    self.ies[xpubinfo._id] = self.ies[xpubinfo._id] + 1
  }
  var initialized = {}
  var address_count = {}
  this.checkAddress = function(xpubinfo, i, initializedCallback) {
    // console.log('xpubinfo', xpubinfo)
    var retrieved = new HDPublicKey(xpubinfo.xpub)
    var derived = retrieved.derive(0).derive(i);
    var address = new Address(derived.publicKey, Networks.livenet);

    client.lrem('available-addresses' + xpubinfo._id, 0, address.toString());
    client.rpush('available-addresses' + xpubinfo._id, address.toString());
    // debugaddress('<checkAddress>', i, address)

    client.sismember('used-addresses' + xpubinfo._id, address.toString(), function(err, res) {
      if (res != 0) {

        self.forgetAddress(address.toString(), xpubinfo, initializedCallback)
      } else {
        bitcoin.getBalance(address.toString()).then(function(transaction) {
          if (transaction.txs > 0) {
            client.get('address-' + address.toString(), function(err, reply) {
              if (reply != null) {
                self.received_payment({ address: address.toString(), amount: self.uBTCtoSAT(transaction.in) }, xpubinfo, initializedCallback)
              } else {
                self.forgetAddress(address.toString(), xpubinfo, initializedCallback)
              }
            })
          } else {
            debugbrp('Monitoring address:', address.toString())
            if (address_count[xpubinfo._id] == undefined) {
              address_count[xpubinfo._id] = 0
            }
            address_count[xpubinfo._id] = address_count[xpubinfo._id] + 1
            console.log('address_count', address_count)
            bitcoin.events.on(address.toString(), function(payment) {
              self.received_payment(payment, xpubinfo, initializedCallback)
            })
            if (address_count[xpubinfo._id] > 4 && initialized[xpubinfo._id] != true) {
              initialized[xpubinfo._id] = true
              initializedCallback()
              // self.events.emit('initialized')
            }
          }
        })
      }
    })
  }


  this.lastrandom = 0
  this.newrandom = 0

  this.check_gap = function(xpubinfo, callback) {
    debugaddress('<check_gap>', xpubinfo)
    if (this.ies[xpubinfo._id] == undefined) {
      this.ies[xpubinfo._id] = 0
    }
    var a = this.ies[xpubinfo._id]
    if (a < max_gap) {
      for (var a = 0; a < max_gap; a++) {
        this.checkAddress(xpubinfo, a, callback)
      }
      // xpubinfo.i = a;
      this.ies[xpubinfo._id] = a
    } else {
      callback()
    }
  }

  this.creatingAddress = false

  self.getOneAvailable = function(id, rawid, addresses, a, Success, Reject) {
    debugaddress('<getOneAvailable>', id)
    is_address_available(addresses[a], id, rawid).then(function(address) {
      Success(address)
    }, function() {
      debugaddress('a:', a, 'max_gap', max_gap)
      if (a < (max_gap - 1)) {
        debugaddress('getOneAvailable')
        self.getOneAvailable(id, rawid, addresses, a + 1, Success, Reject)
      } else {
        debugaddress('Reject')
        Reject()
      }
    })
  }

  var creatingAddresses = {}
  self.createAddress = function(id) {
    console.log('<createAddress>', this.xpub, id)
    return new Promise(function(Succ, Reject) {
      client.get(this.xpub, function(err, xpubid) {
        if (xpubid == null) {
          xpubid = generate_key()
          client.set(this.xpub, xpubid, function(err, reply) {
            console.log('set new key', xpubid, 'for xpub:', this.xpub)
          })
        }
        console.log('got key', xpubid)

        var Success = function(address) {
          creatingAddresses[xpubinfo._id] = false
          seconds_left_for_address(address).then(function(seconds_left) {
            Succ({ address: address, seconds_left: (parseInt(seconds_left) - parseInt(+new Date) / 1000) })
          })
        }

        var process_create_request = function() {
          id_has_address_assigned(id + xpubinfo._id).then(Success, function() {
            client.lrange('available-addresses' + xpubinfo._id, 0, -1, function(err, addresses) {
              if (creatingAddresses[xpubinfo._id] !== true) {
                creatingAddresses[xpubinfo._id] = true
                self.getOneAvailable(id + xpubinfo._id, id, addresses, 0, Success, Reject)
              } else {
                self.newrandom = 100 + 500 * Math.random()
                while (self.lastrandom === self.newrandom) {
                  self.newrandom = 100 + 1000 * Math.random()
                }
                setTimeout(function() {
                  self.getOneAvailable(id + xpubinfo._id, id, addresses, 0, Success, Reject)
                }, self.newrandom)
                self.lastrandom = self.newrandom
              }
            })
          })
        }

        var xpubinfo = { _id: xpubid, xpub: self.xpub }
        if (self.ies[xpubinfo._id] == undefined) {
          self.check_gap(xpubinfo, process_create_request)
        } else {
          process_create_request()
        }
      })
    })
  }

  self.connect = function() {
    bitcoin.events.on('connected', function() {
      // self.check_gap()
    })
    bitcoin.connect()
  }


  return this
}
