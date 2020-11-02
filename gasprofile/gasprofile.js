/***
 * Inspired by & rewritten from: https://github.com/yushih/solidity-gas-profiler;
 * added support for multiple contracts (call, delegatecall, etc.), multiple sources
 * per contract (inheritance), and transactions/opcodes that construct new contracts.
 **/

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const binarysearch = require('binarysearch');
const Web3 = require('web3');
const BN = require('bn.js');

const makeSource = (id, fileName) => ({
  id,
  fileName,
  skip: false,
  text: null,
  lineOffsets: null,
  lineGas: [],
  linesWithCalls: {}
});

const makeContract = addressHexStr => ({
  addressHexStr,
  codeHexStr: null,
  constructionСodeHexStr: null,
  fileName: null,
  name: null,
  sourcesById: {},
  sourceMap: null,
  constructorSourceMap: null,
  pcToIdx: null,
  constructionPcToIdx: null,
  totalGasCost: 0,
  synthGasCost: 0
});

const makeCallStackItem = contract => ({
  contract,
  isConstructionCall: false,
  gasBefore: 0,
  gasBeforeOutgoingCall: 0,
  outgoingCallSource: null,
  outgoingCallLine: null
})

const contractByAddr = {};
const sourceById = {};
const sourceByFilename = {};

const argv = yargs(yargs.hideBin(process.argv))
  .usage(
    '$0 <solc-output-json> <transaction-hash>',
    'Display line-by-line gas usage of the given transaction',
    cmd => cmd
      .positional('solc-output-json', {
        describe: 'the file containing JSON generated by solc using its --standard-json flag',
        type: 'string'
      })
      .positional('transaction-hash', {
        describe: 'hash of the transaction to profile',
        type: 'string'
      })
      .option('S', {
        alias: 'skip',
        type: 'array',
        default: [],
        describe: 'skip printing gas usage for filenames containing this substring'
      })
      .option('R', {
        alias: 'src-root',
        type: 'string',
        default: '.',
        describe: 'the directory relative to which the source paths inside <solc-output-json> file should be resolved'
      })
      .option('e', {
        alias: 'rpc-endpoint',
        type: 'string',
        default: 'http://localhost:8545',
        describe: 'JSON-RPC endpoint; should support the debug_traceTransaction method'
      })
  )
  .help()
  .strict()
  .argv;

main(argv)
  .catch(e => console.error(e.stack))
  .then(() => process.exit(0));

async function main(argv) {
  const provider = new Web3.providers.HttpProvider(argv.rpcEndpoint);
  const web3 = new Web3(provider);

  web3.extend({methods: [
    {
      name: 'traceTx',
      call: 'debug_traceTransaction',
      params: 2
    }
  ]});

  const txHash = argv.transactionHash;
  const solcOutput = JSON.parse(fs.readFileSync(argv.solcOutputJson, 'utf8'));
  const sourceRoot = argv.srcRoot;
  const skipFiles = argv.skip;

  const [receipt, tx] = await Promise.all([
    web3.eth.getTransactionReceipt(txHash),
    web3.eth.getTransaction(txHash)
  ]);

  console.log('Gas used by transaction:', receipt.gasUsed);

  const isEntryCallConstruction = !tx.to && !!receipt.contractAddress;
  const entryAddr = isEntryCallConstruction ? receipt.contractAddress : tx.to;

  assert(!!entryAddr);

  const entryContract = await getContractWithAddr(entryAddr, web3, solcOutput);
  if (!entryContract) {
    console.log(`The transaction target address is not a contract`);
    return
  }

  // https://github.com/ethereum/go-ethereum/wiki/Tracing:-Introduction
  const trace = await web3.traceTx(txHash, {
    disableStack: false,
    disableMemory: true,
    disableStorage: true
  });

  const entryCall = makeCallStackItem(entryContract);
  entryCall.isConstructionCall = isEntryCallConstruction;

  const callStack = [entryCall];
  const bottomDepth = trace.structLogs[0].depth; // 1 in geth, 0 in ganache

  for (let i = 0; i < trace.structLogs.length; ++i) {
    const log = trace.structLogs[i];
    const gasCost = getGasCost(log);

    // console.error(`${log.op}, gas ${log.gas}, gasCost ${gasCost}, pc ${log.pc}, depth ${log.depth}`);

    while (log.depth - bottomDepth < callStack.length - 1) {
      const prevTopCall = callStack.pop();
      // using the prev opcode since Ganache reports RETURN opcodes as having negative cost
      const prevLog = trace.structLogs[i - 1];
      prevTopCall.contract.totalGasCost += prevTopCall.gasBefore - prevLog.gas + getGasCost(prevLog);

      const topCall = callStack[callStack.length - 1];
      const cumulativeCallCost = topCall.gasBeforeOutgoingCall - log.gas;
      increaseLineGasCost(topCall.outgoingCallSource, topCall.outgoingCallLine, cumulativeCallCost, true);
    }

    assert(callStack.length > 0);

    const call = callStack[log.depth - bottomDepth];
    const {source, line, isSynthOp} = getSourcePosition(call, log, solcOutput, sourceRoot, skipFiles);

    const nextLog = trace.structLogs[i + 1];
    const outgoingCallTarget = getCallTarget(log, i, trace.structLogs);

    if (outgoingCallTarget.addressHexStr && nextLog && nextLog.depth > log.depth) {
      // the current instruction is a call or create instruction
      assert(nextLog.depth === log.depth + 1);

      call.outgoingCallSource = source;
      call.outgoingCallLine = line;
      call.gasBeforeOutgoingCall = log.gas;

      const targetContract = await getContractWithAddr(outgoingCallTarget.addressHexStr, web3, solcOutput);
      const outgoingCall = makeCallStackItem(targetContract);

      outgoingCall.isConstructionCall = outgoingCallTarget.isConstructionCall;
      outgoingCall.gasBefore = nextLog.gas;

      callStack.push(outgoingCall);
    } else {
      if (isSynthOp) {
        call.contract.synthGasCost += gasCost;
      } else {
        increaseLineGasCost(source, line, gasCost, false);
      }
    }
  }

  const firstLog = trace.structLogs[0];
  const lastLog = trace.structLogs[trace.structLogs.length - 1];

  entryContract.totalGasCost = firstLog.gas - lastLog.gas + getGasCost(lastLog);

  Object.keys(contractByAddr).forEach(addressHexStr => {
    const contract = contractByAddr[addressHexStr];
    if (contract.name == null) {
      console.log(`\nUnknown contract at 0x${addressHexStr}`);
    } else {
      const fileNames = Object.keys(contract.sourcesById)
        .map(id => contract.sourcesById[id])
        .map(source => source && source.fileName)
        .filter(x => !!x)
        .join(', ')
      console.log(`\nContract ${contract.name} at 0x${addressHexStr}`);
      console.log(`  defined in: ${fileNames || contract.fileName || '<no sources found>'}`);
      console.log('  synthetic instruction gas:', contract.synthGasCost);
      // showAllPointsInSourceMap(contract.sourceMap, contract.source, contract.lineOffsets);
    }
    console.log('  total gas spent in the contract:', contract.totalGasCost);
  });

  let hasCalls = false;

  Object.keys(sourceByFilename).forEach(fileName => {
    const source = sourceByFilename[fileName];
    if (!source.text) {
      return;
    }

    console.log(`\nFile ${fileName}\n`);

    source.text.split('\n').forEach((lineText, i) => {
      const gas = source.lineGas[i] || 0;
      const containsCall = !!source.linesWithCalls[i];
      if (containsCall && !hasCalls) {
        hasCalls = true;
      }
      console.log(`${gas}${containsCall ? '+' : ''}\t\t${lineText}`);
    });
  });

  if (hasCalls) {
    console.log(`\nLines marked with + contain calls to other contracts, and gas`);
    console.log(`usage of such lines includes the gas spent by the called code.`);
  }
}

async function getContractWithAddr(addr, web3, solcOutput) {
  const addressHexStr = normalizeAddress(addr);

  const cached = contractByAddr[addressHexStr];
  if (cached) {
    return cached;
  }

  const result = makeContract(addressHexStr);
  contractByAddr[addressHexStr] = result;

  result.codeHexStr = strip0x(await web3.eth.getCode(addressHexStr)) || null;
  if (!result.codeHexStr) {
    console.error(`WARN no code at address 0x${addressHexStr}`);
    return result;
  }

  result.pcToIdx = buildPcToInstructionMapping(result.codeHexStr);

  const contractData = findContractByDeployedBytecode(result.codeHexStr, solcOutput);
  if (!contractData) {
    console.error(`WARN no source for contract at address 0x${addressHexStr}`);
    return result;
  }

  result.constructionСodeHexStr = contractData.constructionСodeHexStr;
  result.constructionPcToIdx = buildPcToInstructionMapping(result.constructionСodeHexStr);

  result.name = contractData.name;
  result.fileName = contractData.fileName;
  result.sourceMap = parseSourceMap(contractData.sourceMap);
  result.constructorSourceMap = parseSourceMap(contractData.constructorSourceMap);

  return result;
}

function findContractByDeployedBytecode(codeHexStr, solcOutput) {
  const filesNames = Object.keys(solcOutput.contracts);
  for (let iFile = 0; iFile < filesNames.length; ++iFile) {
    const fileName = filesNames[iFile];
    const fileContracts = solcOutput.contracts[fileName];
    const contractNames = Object.keys(fileContracts);
    for (let iContract = 0; iContract < contractNames.length; ++iContract) {
      const name = contractNames[iContract];
      const contractData = fileContracts[name];
      if (contractData.evm.deployedBytecode.object === codeHexStr) {
        return {
          fileName,
          name,
          sourceMap: contractData.evm.deployedBytecode.sourceMap,
          constructorSourceMap: contractData.evm.bytecode.sourceMap,
          constructionСodeHexStr: contractData.evm.bytecode.object
        };
      }
    }
  }
  return null;
}

function getSourceWithId(sourceId, solcOutput, sourceRoot, skipFiles) {
  const cached = sourceById[sourceId];
  if (cached) {
    return cached;
  }

  const fileName = Object
    .keys(solcOutput.sources)
    .find(sourceFileName => solcOutput.sources[sourceFileName].id === sourceId) || null;

  if (!fileName) {
    console.error(`WARN no source with id ${sourceId}`);
    return sourceById[sourceId] = makeSource(sourceId, null);
  }

  return getSourceForFilename(fileName, solcOutput, sourceRoot, skipFiles);
}

function getSourceForFilename(fileName, solcOutput, sourceRoot, skipFiles) {
  const cached = sourceByFilename[fileName];
  if (cached) {
    return cached;
  }

  const result = makeSource(null, fileName);
  sourceByFilename[fileName] = result;

  const sourceData = solcOutput.sources[fileName];
  if (!sourceData) {
    console.error(`WARN no source info for filename ${fileName}`);
    return result;
  }

  result.id = sourceData.id;
  result.skip = skipFiles.some(str => fileName.indexOf(str) !== -1);
  sourceById[result.id] = result;

  if (!result.skip) {
    result.text = readSource(fileName, sourceRoot);
  }

  if (result.text) {
    result.lineOffsets = buildLineOffsets(result.text);
  } else if (!result.skip) {
    console.error(`WARN no source text for filename ${fileName} (id ${result.id})`);
  }

  return result;
}

function readSource(fileName, sourceRoot) {
  try {
    const sourcePath = path.resolve(__dirname, sourceRoot, fileName);
    return fs.readFileSync(sourcePath, 'utf8');
  } catch (err) {
    try {
      const sourcePath = require.resolve(fileName);
      return fs.readFileSync(sourcePath, 'utf8');
    } catch (err) {
      return null;
    }
  }
}

function getCallTarget(log, iLog, structLogs) {
  switch (log.op) {
    case 'CALL': // https://ethervm.io/#F1
    case 'CALLCODE': // https://ethervm.io/#F2
    case 'DELEGATECALL': // https://ethervm.io/#F4
    case 'STATICCALL': { // https://ethervm.io/#FA
      return {
        addressHexStr: normalizeAddress(log.stack[log.stack.length - 2]),
        isConstructionCall: false
      };
    }
    case 'CREATE': // https://ethervm.io/#F0
    case 'CREATE2': { // https://ethervm.io/#F5
      let nextLogSameDepth = null;
      for (++iLog; iLog < structLogs.length && !nextLogSameDepth; ++iLog) {
        const nextLog = structLogs[iLog];
        if (nextLog.depth === log.depth) {
          nextLogSameDepth = nextLog;
        }
      }
      return {
        addressHexStr: nextLogSameDepth
          ? normalizeAddress(nextLogSameDepth.stack[nextLogSameDepth.stack.length - 1])
          : null,
        isConstructionCall: true
      };
    }
    default: {
      return {
        addressHexStr: null,
        isConstructionCall: false
      };
    }
  }
}

function getSourcePosition(call, log, solcOutput, sourceRoot, skipFiles) {
  const result = {source: null, line: null, isSynthOp: false};

  const {contract} = call;
  const pcToIdx = call.isConstructionCall ? contract.constructionPcToIdx : contract.pcToIdx;
  const sourceMap = call.isConstructionCall ? contract.constructorSourceMap : contract.sourceMap;

  if (!pcToIdx || !sourceMap) {
    return result;
  }

  const instructionIdx = pcToIdx[log.pc];
  const {s: sourceOffset, f: sourceId} = sourceMap[instructionIdx];

  if (sourceId === -1) {
    // > In the case of instructions that are not associated with any particular source file,
    // > the source mapping assigns an integer identifier of -1. This may happen for bytecode
    // > sections stemming from compiler-generated inline assembly statements.
    // From: https://solidity.readthedocs.io/en/v0.6.7/internals/source_mappings.html
    result.isSynthOp = true;
    return result;
  }

  result.source = getSourceWithId(sourceId, solcOutput, sourceRoot, skipFiles) || null;

  if (contract.sourcesById[sourceId] === undefined) {
    contract.sourcesById[sourceId] = result.source;
  }

  if (result.source && result.source.lineOffsets) {
    result.line = binarysearch.closest(result.source.lineOffsets, sourceOffset);
  }

  return result;
}

function getGasCost(log) {
  // See: https://github.com/trufflesuite/ganache-core/issues/277
  // See: https://github.com/trufflesuite/ganache-core/pull/578
  if (log.gasCost < 0 && (log.op === 'RETURN' || log.op === 'REVERT' || log.op === 'STOP')) {
    console.error(`WARN skipping invalid gasCost value ${log.gasCost} for op ${log.op}`);
    return 0;
  } else {
    return log.gasCost;
  }
}

function increaseLineGasCost(source, line, gasCost, isCall) {
  if (source != null && line != null && !source.skip) {
    source.lineGas[line] = (source.lineGas[line] | 0) + gasCost;
    if (isCall) {
      source.linesWithCalls[line] = true;
    }
  }
}

function showAllPointsInSourceMap (sourceMap, src, lineOffsets) {
  const linePoints = []; //line no -> number of points in source map
  sourceMap.forEach(instruction=>{
    if (instruction.f === -1) {
        return;
    }
    const s = instruction.s;
    const line = binarysearch.closest(lineOffsets, s);
    if (line === 0) {
        console.log('>>>', instruction);
    }
    if (linePoints[line] === undefined) {
        linePoints[line] = 1;
    } else {
        linePoints[line] += 1;
    }
  });

  src.split('\n').forEach((line, i) => {
    const points = linePoints[i] || 0;
    console.log('%s\t%s\t%s\t\t%s', i, lineOffsets[i], points, line);
  });
}

function buildLineOffsets (src) {
  let accu = 0;
  return src.split('\n').map(line => {
    const ret = accu;
    accu += line.length + 1;
    return ret;
  });
}

function buildPcToInstructionMapping (codeHexStr) {
  const mapping = {};
  let instructionIndex = 0;
  for (let pc=0; pc<codeHexStr.length/2;) {
    mapping[pc] = instructionIndex;

    const byteHex = codeHexStr[pc*2]+codeHexStr[pc*2+1];
    const byte = parseInt(byteHex, 16);

    // PUSH instruction has immediates
    if (byte >= 0x60 && byte <= 0x7f) {
        const n = byte-0x60+1; // number of immediates
        pc += (n+1);
    } else {
        pc += 1;
    }

    instructionIndex += 1;
  }
  return mapping;
}

// https://solidity.readthedocs.io/en/develop/miscellaneous.html#source-mappings
function parseSourceMap (raw) {
  let prevS, prevL, prevF, prevJ;
  return raw.trim().split(';').map(section=> {
    let [s,l,f,j] = section.split(':');

    if (s==='' || s===undefined) {
      s = prevS;
    } else {
      prevS = s;
    }

    if (l==='' || l===undefined) {
      l = prevL;
    } else {
      prevL = l;
    }

    if (f==='' || f===undefined) {
      f = prevF;
    } else {
      prevF = f;
    }

    if (j==='' || j===undefined) {
      j = prevJ;
    } else {
      prevJ = j;
    }

    return {s:Number(s), l:Number(l), f:Number(f), j};
  });
}

function normalizeAddress(addressHexStr) {
  if (!addressHexStr) {
    return addressHexStr;
  }
  const addressBN = new BN(strip0x(addressHexStr), 16);
  return addressBN.toString(16, 40);
}

function strip0x(hexStr) {
  return hexStr && hexStr[0] === '0' && hexStr[1] === 'x'
    ? hexStr.substring(2)
    : hexStr
}
