var BigInteger = require('./jsbn/jsbn');
var Script = require('./script');
var util = require('./util');
var convert = require('./convert');
var ECKey = require('./eckey').ECKey;
var ECDSA = require('./ecdsa');
var Address = require('./address');
var SHA256 = require('crypto-js/sha256');

var Transaction = function (doc) {
    if (!(this instanceof Transaction)) { return new Transaction(doc); }
    this.version = 1;
    this.locktime = 0;
    this.ins = [];
    this.outs = [];
    this.defaultSequence = [255, 255, 255, 255]; // 0xFFFFFFFF

    if (doc) {
        if (typeof doc == "string" || Array.isArray(doc)) {
            doc = Transaction.deserialize(doc);
        }

        if (doc.hash) this.hash = doc.hash;
        if (doc.version) this.version = doc.version;
        if (doc.locktime) this.locktime = doc.locktime;
        if (doc.ins && doc.ins.length) {
            doc.ins.forEach(function(input) {
                this.addInput(new TransactionIn(input));
            }, this);
        }

        if (doc.outs && doc.outs.length) {
            doc.outs.forEach(function(output) {
                this.addOutput(new TransactionOut(output));
            }, this);
        }

        this.hash = this.hash || this.getHash();
    }
};

/**
 * Create a new txin.
 *
 * Can be called with any of:
 *
 * - An existing TransactionIn object
 * - A transaction and an index
 * - A transaction hash and an index
 * - A single string argument of the form txhash:index
 *
 * Note that this method does not sign the created input.
 */
Transaction.prototype.addInput = function (tx, outIndex) {
    if (arguments[0] instanceof TransactionIn) {
        this.ins.push(arguments[0]);
    }
    else if (arguments[0].length > 65) {
        var args = arguments[0].split(':');
        return this.addInput(args[0], args[1]);
    }
    else {
        var hash = typeof tx === "string" ? tx : tx.hash;
        hash = Array.isArray(hash) ? convert.bytesToHex(hash) : hash;

        this.ins.push(new TransactionIn({
            outpoint: {
                hash: hash,
                index: outIndex
            },
            script: new Script(),
            sequence: this.defaultSequence
        }));
    }
};

/**
 * Create a new txout.
 *
 * Can be called with:
 *
 * i) An existing TransactionOut object
 * ii) An address object or an address and a value
 * iii) An address:value string
 *
 */
Transaction.prototype.addOutput = function (address, value) {
    if (arguments[0] instanceof TransactionOut) {
       this.outs.push(arguments[0]);
       return;
    }

    if (arguments[0].indexOf(':') >= 0) {
        var args = arguments[0].split(':');
        address = args[0];
        value = parseInt(args[1]);
    }

    this.outs.push(new TransactionOut({
        value: value,
        script: Script.createOutputScript(address)
    }));
};

/**
 * Serialize this transaction.
 *
 * Returns the transaction as a byte array in the standard Bitcoin binary
 * format. This method is byte-perfect, i.e. the resulting byte array can
 * be hashed to get the transaction's standard Bitcoin hash.
 */
Transaction.prototype.serialize = function () {
    var buffer = [];
    buffer = buffer.concat(convert.numToBytes(parseInt(this.version), 4));
    buffer = buffer.concat(convert.numToVarInt(this.ins.length));

    this.ins.forEach(function(txin) {
        // Why do blockchain.info, blockexplorer.com, sx and just about everybody
        // else use little-endian hashes? No idea...
        buffer = buffer.concat(convert.hexToBytes(txin.outpoint.hash).reverse());

        buffer = buffer.concat(convert.numToBytes(parseInt(txin.outpoint.index), 4));

        var scriptBytes = txin.script.buffer;
        buffer = buffer.concat(convert.numToVarInt(scriptBytes.length));
        buffer = buffer.concat(scriptBytes);
        buffer = buffer.concat(txin.sequence);
    });

    buffer = buffer.concat(convert.numToVarInt(this.outs.length));

    this.outs.forEach(function(txout) {
        buffer = buffer.concat(convert.numToBytes(txout.value,8));

        var scriptBytes = txout.script.buffer;
        buffer = buffer.concat(convert.numToVarInt(scriptBytes.length));
        buffer = buffer.concat(scriptBytes);
    });

    buffer = buffer.concat(convert.numToBytes(parseInt(this.locktime), 4));

    return buffer;
};

Transaction.prototype.serializeHex = function() {
    return convert.bytesToHex(this.serialize());
}

//var OP_CODESEPARATOR = 171;

var SIGHASH_ALL = 1;
var SIGHASH_NONE = 2;
var SIGHASH_SINGLE = 3;
var SIGHASH_ANYONECANPAY = 80;

/**
 * Hash transaction for signing a specific input.
 *
 * Bitcoin uses a different hash for each signed transaction input. This
 * method copies the transaction, makes the necessary changes based on the
 * hashType, serializes and finally hashes the result. This hash can then be
 * used to sign the transaction input in question.
 */
Transaction.prototype.hashTransactionForSignature =
function (connectedScript, inIndex, hashType)
{
  var txTmp = this.clone();

  // In case concatenating two scripts ends up with two codeseparators,
  // or an extra one at the end, this prevents all those possible
  // incompatibilities.
  /*scriptCode = scriptCode.filter(function (val) {
   return val !== OP_CODESEPARATOR;
   });*/

  // Blank out other inputs' signatures
  txTmp.ins.forEach(function(txin) {
    txin.script = new Script();
  });

  txTmp.ins[inIndex].script = connectedScript;

  // Blank out some of the outputs
  if ((hashType & 0x1f) == SIGHASH_NONE) {
    txTmp.outs = [];

    // Let the others update at will
    txTmp.ins.forEach(function(txin, i) {
      if (i != inIndex) {
        txTmp.ins[i].sequence = 0;
      }
    });

  } else if ((hashType & 0x1f) == SIGHASH_SINGLE) {
    // TODO: Implement
  }

  // Blank out other inputs completely, not recommended for open transactions
  if (hashType & SIGHASH_ANYONECANPAY) {
    txTmp.ins = [txTmp.ins[inIndex]];
  }

  var buffer = txTmp.serialize();

  buffer = buffer.concat(convert.numToBytes(parseInt(hashType), 4));
  buffer = convert.bytesToWordArray(buffer);

  return convert.wordArrayToBytes(SHA256(SHA256(buffer)));
};

/**
 * Calculate and return the transaction's hash.
 * Reverses hash since blockchain.info, blockexplorer.com and others
 * use little-endian hashes for some stupid reason
 */
Transaction.prototype.getHash = function ()
{
  var buffer = convert.bytesToWordArray(this.serialize());
  return convert.wordArrayToBytes(SHA256(SHA256(buffer))).reverse();
};

/**
 * Create a copy of this transaction object.
 */
Transaction.prototype.clone = function ()
{
  var newTx = new Transaction();
  newTx.version = this.version;
  newTx.locktime = this.locktime;

  this.ins.forEach(function(txin) {
    newTx.addInput(txin.clone());
  });

  this.outs.forEach(function(txout) {
    newTx.addOutput(txout.clone());
  });

  return newTx;
};

/**
 * Converts a serialized transaction into a transaction object
 */

Transaction.deserialize = function(buffer) {
    if (typeof buffer == "string") {
        buffer = convert.hexToBytes(buffer)
    }
    var pos = 0;
    var readAsInt = function(bytes) {
        if (bytes === 0) return 0;
        pos++;
        return buffer[pos-1] + readAsInt(bytes-1) * 256;
    }
    var readVarInt = function() {
        pos++;
        if (buffer[pos-1] < 253) {
            return buffer[pos-1];
        }
        return readAsInt(buffer[pos-1] - 251);
    }
    var readBytes = function(bytes) {
        pos += bytes;
        return buffer.slice(pos - bytes, pos);
    }
    var readVarString = function() {
        var size = readVarInt();
        return readBytes(size);
    }
    var obj = {
        ins: [],
        outs: []
    }
    obj.version = readAsInt(4);
    var ins = readVarInt();
    var i;

    for (i = 0; i < ins; i++) {
        obj.ins.push({
            outpoint: {
                hash: convert.bytesToHex(readBytes(32).reverse()),
                index: readAsInt(4)
            },
            script: new Script(readVarString()),
            sequence: readBytes(4)
        });
    }
    var outs = readVarInt();

    for (i = 0; i < outs; i++) {
        obj.outs.push({
            value: convert.bytesToNum(readBytes(8)),
            script: new Script(readVarString())
        });
    }

    obj.locktime = readAsInt(4);

    return new Transaction(obj);
}

/**
 * Signs a standard output at some index with the given key
 */

Transaction.prototype.sign = function(index, key, type) {
    type = type || SIGHASH_ALL;
    key = new ECKey(key);

    // TODO: getPub is slow, sha256ripe160 probably is too.
    // This could be sped up a lot by providing these as inputs.
    var pub = key.getPub().export('bytes'),
        hash160 = util.sha256ripe160(pub),
        script = Script.createOutputScript(new Address(hash160)),
        hash = this.hashTransactionForSignature( script, index, type),
        sig = key.sign(hash).concat([type]);
    this.ins[index].script = Script.createInputScript(sig,pub);
}

// Takes outputs of the form [{ output: 'txhash:index', address: 'address' },...]
Transaction.prototype.signWithKeys = function(keys, outputs, type) {
    type = type || SIGHASH_ALL;

    var addrdata = keys.map(function(key) {
         key = new ECKey(key);
         return {
            key: key,
            address: key.getAddress().toString()
         }
    });

    var hmap = {};
    outputs.forEach(function(o) {
        hmap[o.output] = o;
    });

    for (var i = 0; i < this.ins.length; i++) {
        var outpoint = this.ins[i].outpoint.hash + ':' + this.ins[i].outpoint.index;
        var histItem = hmap[outpoint];

        if (!histItem) continue;

        var thisInputAddrdata = addrdata.filter(function(a) {
            return a.address == histItem.address;
        });

        if (thisInputAddrdata.length === 0) continue;

        this.sign(i,thisInputAddrdata[0].key);
    }
}

/**
 * Signs a P2SH output at some index with the given key
 */

Transaction.prototype.p2shsign = function(index, script, key, type) {
    script = new Script(script);
    key = new ECKey(key);
    type = type || SIGHASH_ALL;
    var hash = this.hashTransactionForSignature(script, index, type),
        sig = key.sign(hash).concat([type]);
    return sig;
}

Transaction.prototype.multisign = Transaction.prototype.p2shsign;

Transaction.prototype.applyMultisigs = function(index, script, sigs/*, type*/) {
    this.ins[index].script = Script.createMultiSigInputScript(sigs, script);
}

Transaction.prototype.validateSig = function(index, script, sig, pub) {
    script = new Script(script);
    var hash = this.hashTransactionForSignature(script,index,1);
    return ECDSA.verify(hash, convert.coerceToBytes(sig),
                                      convert.coerceToBytes(pub));
}

Transaction.feePerKb = 20000
Transaction.prototype.estimateFee = function(feePerKb){
  var uncompressedInSize = 180
  var outSize = 34
  var fixedPadding = 34

  if(feePerKb == undefined) feePerKb = Transaction.feePerKb
  var size = this.ins.length * uncompressedInSize + this.outs.length * outSize + fixedPadding

  return feePerKb * Math.ceil(size / 1000)
}

var TransactionIn = function (data) {
    if (typeof data == "string")
        this.outpoint = { hash: data.split(':')[0], index: data.split(':')[1] }
    else if (data.outpoint)
        this.outpoint = data.outpoint
    else
        this.outpoint = { hash: data.hash, index: data.index }

    if (data.scriptSig)
        this.script = Script.fromScriptSig(data.scriptSig)
    else if (data.script)
        this.script = data.script
    else
        this.script = new Script(data.script)

    this.sequence = data.sequence || this.defaultSequence
};

TransactionIn.prototype.clone = function () {
    return new TransactionIn({
        outpoint: {
            hash: this.outpoint.hash,
            index: this.outpoint.index
        },
        script: this.script.clone(),
        sequence: this.sequence
    });
};

var TransactionOut = function (data) {
    this.script =
        data.script instanceof Script    ? data.script.clone()
      : Array.isArray(data.script)        ? new Script(data.script)
      : typeof data.script == "string"   ? new Script(convert.hexToBytes(data.script))
      : data.scriptPubKey                ? Script.fromScriptSig(data.scriptPubKey)
      : data.address                     ? Script.createOutputScript(data.address)
      :                                    new Script();

    if (this.script.buffer.length > 0) this.address = this.script.getToAddress();

    this.value =
        Array.isArray(data.value)         ? convert.bytesToNum(data.value)
      : "string" == typeof data.value    ? parseInt(data.value)
      : data.value instanceof BigInteger ? parseInt(data.value.toString())
      :                                    data.value;
};

TransactionOut.prototype.clone = function() {
  var newTxout = new TransactionOut({
    script: this.script.clone(),
    value: this.value
  });
  return newTxout;
};

TransactionOut.prototype.scriptPubKey = function() {
  return convert.bytesToHex(this.script.buffer)
}

module.exports = {
  Transaction: Transaction,
  TransactionIn: TransactionIn,
  TransactionOut: TransactionOut
}
