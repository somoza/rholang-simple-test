var express = require('express');
const { ec } = require('elliptic');
const jspb = require('google-protobuf');
const blake = require('blakejs');
const fetch = (...args) =>
    import ('node-fetch').then(({ default: fetch }) => fetch(...args));
const { exec } = require('child_process');

//Protobuf function
const deployDataProtobufSerialize = deployData => {
    const { term, timestamp, phloPrice, phloLimit, validAfterBlockNumber } = deployData

    // Create binary stream writer
    const writer = new jspb.BinaryWriter()
        // Write fields (protobuf doesn't serialize default values)
    const writeString = (order, val) => val != "" && writer.writeString(order, val)
    const writeInt64 = (order, val) => val != 0 && writer.writeInt64(order, val)

    // https://github.com/rchain/rchain/blob/f7e46a9/models/src/main/protobuf/CasperMessage.proto#L134-L143
    // message DeployDataProto {
    //   bytes  deployer     = 1; //public key
    //   string term         = 2; //rholang source code to deploy (will be parsed into `Par`)
    //   int64  timestamp    = 3; //millisecond timestamp
    //   bytes  sig          = 4; //signature of (hash(term) + timestamp) using private key
    //   string sigAlgorithm = 5; //name of the algorithm used to sign
    //   int64 phloPrice     = 7; //phlo price
    //   int64 phloLimit     = 8; //phlo limit for the deployment
    //   int64 validAfterBlockNumber = 10;
    // }

    // Serialize fields
    writeString(2, term)
    writeInt64(3, timestamp)
    writeInt64(7, phloPrice)
    writeInt64(8, phloLimit)
    writeInt64(10, validAfterBlockNumber)

    return writer.getResultBuffer()
}

const encodeBase16 = bytes =>
    Array.from(bytes).map(x => (x & 0xff).toString(16).padStart(2, "0")).join('')

//#6. Create singing key from private
const signPrivKey = (deployData, privateKey) => {
    // Create signing key from given private
    const secp256k1 = new ec('secp256k1')
    const key = secp256k1.keyFromPrivate(privateKey)

    const deploySignature = signDeploy(key, deployData)
    return createSignedDeploy(deploySignature)
}

//#7.1 Serialize deploy with protobuf
//#7.2 Get signer private key
//#7.3 Get deployer 
//#7.4 Hash the serialized deploy with blake
//#7.5 Sign the generated hash on 7.4 with signer key
const signDeploy = (privateKey, deployObj) => {
    const {
        term,
        timestamp,
        phloPrice,
        phloLimit,
        validAfterBlockNumber,
        sigAlgorithm = 'secp256k1',
    } = deployObj

    // Serialize deploy data for signing
    const deploySerialized = deployDataProtobufSerialize({
        term,
        timestamp,
        phloPrice,
        phloLimit,
        validAfterBlockNumber,
    })

    const getSignKey = (crypt, privateKey) =>
        privateKey && privateKey.sign && privateKey.sign.constructor == Function ? privateKey : crypt.keyFromPrivate(privateKey)

    // Signing key
    const crypt = new ec(sigAlgorithm)
    const key = getSignKey(crypt, privateKey)
    const deployer = Uint8Array.from(key.getPublic('array'))
        // Hash and sign serialized deploy
    const hashed = blake.blake2bHex(deploySerialized, void 666, 32)
    const sigArray = key.sign(hashed, { canonical: true }).toDER('array')
    const sig = Uint8Array.from(sigArray)

    // Return deploy object / ready for sending to RNode
    return {
        term,
        timestamp,
        phloPrice,
        phloLimit,
        validAfterBlockNumber,
        deployer,
        sig,
        sigAlgorithm,
    }
}

//#8. Build final deploy object with signs
const createSignedDeploy = deployData => {
    const {
        term,
        timestamp,
        phloPrice,
        phloLimit,
        validAfterBlockNumber,
        deployer,
        sig,
        sigAlgorithm,
    } = deployData

    const result = {
        data: { term, timestamp, phloPrice, phloLimit, validAfterBlockNumber },
        sigAlgorithm,
        signature: encodeBase16(sig),
        deployer: encodeBase16(deployer),
    }
    return result
}



const rnodeApiCall = (httpUrl, apiMethod, data) => {
    // Prepare fetch options
    const postMethods = ['prepare-deploy', 'deploy', 'data-at-name', 'explore-deploy', 'propose']
    const isPost = !!data && R.includes(apiMethod, postMethods)
    const httpMethod = isPost ? 'POST' : 'GET'
    const url = method => `${httpUrl}/api/${method}`
    const body = typeof data === 'string' ? data : JSON.stringify(data)
    const response = fetch(url, {
        method: httpMethod,
        body: body,
        headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error(`unexpected response ${response.statusText}`);
    return response;
}


var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
    res.render('index', { title: 'Express' });
});

router.post('/deploy-contract', function(req, res, next) {
    //The contract to deploy.
    //#1. the contract code.
    const blockNumber = req.body.blockNumber;
    const contract = `new brewery, stdout(\`rho:io:stdout\`) in {
        brewery!("2 golden please")
      |
      for(order <- brewery){
        stdout!("Beer on the way, skol!")
      }
    }`;

    //#2. Get the lastest block number from frontentd (could be here too)

    //#3. Prepare the basic deploy object
    const deployData = {
        term: contract,
        phloLimit: 500000, //TODO: Make this dynamic
        phloPrice: 1, //TODO: Make this dynamic
        validAfterBlockNumber: blockNumber,
        timestamp: Date.now()
    }

    //#4. Convert the deploy to processed and signed object.
    const sign = signPrivKey(deployData, '28a5c9ac133b4449ca38e9bdf7cacdce31079ef6b3ac2f0a080af83ecff98b36'); //TODO: Get this private key from config.

    //#5. Send to front!
    res.json({ deploy: sign });
});

router.post('/place-order', function(req, res, next) {
    const item = req.body.beer;
    const order = `new brewery in {
        brewery!("APA please")
      }`;

    const deployData = {
        term: order,
        phloLimit: 500000, //TODO: Make this dynamic
        phloPrice: 1, //TODO: Make this dynamic
        validAfterBlockNumber: 2, //blockNumber,
        timestamp: Date.now()
    }

    //#4. Convert the deploy to processed and signed object.
    const sign = signPrivKey(deployData, '28a5c9ac133b4449ca38e9bdf7cacdce31079ef6b3ac2f0a080af83ecff98b36'); //TODO: Get this private key from config.

    //#5. Send to front!
    res.json({ deploy: sign });
});

router.get('/propose', function(req, res, next) {
    exec('rnode --grpc-port 40402 propose');
});

module.exports = router;