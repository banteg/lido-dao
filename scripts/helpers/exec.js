const childProcess = require('child_process')

const {log} = require('./log')

function exec(cmdWithArgs, opts) {
  return new Promise((resolve, reject) => {
    childProcess.exec(cmd, opts, (err, stdout, stderr) => {
      if (err) {
        reject(err)
      } else {
        resolve({stdout, stderr})
      }
    })
  })
}

function execLive(cmd, {args, cwd, env}) {
  return new Promise((resolve, reject) => {
    args = args || []
    log(`+ cd ${cwd || process.cwd()} && ${cmd}${args.length ? ' ' + args.join(' ') : ''}`)
    const proc = childProcess.spawn(cmd, args, {cwd, env, stdio: 'inherit'})
    proc.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

module.exports = {exec, execLive}
