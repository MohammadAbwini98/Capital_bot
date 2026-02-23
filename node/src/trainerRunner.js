// ==============================================================
// GoldBot — trainerRunner.js
// Runs the Python ML training pipeline from within Node.js.
// Called automatically every night ~30 min after UTC midnight.
//
// Pipeline:
//   1. label_signals.py  — computes training labels from candle DB
//   2. train.py          — trains logistic regression, writes model JSON
//   3. mlModel.reload()  — hot-loads the new model (no restart needed)
// ==============================================================

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const log       = require('./logger');
const mlModel   = require('./mlModel');

const TRAINER_DIR  = path.resolve(__dirname, '../../trainer');
const VENV_PYTHON  = path.join(TRAINER_DIR, '.venv', 'bin', 'python3');

/**
 * Spawn a Python script from the trainer venv, streaming its output
 * to the bot log.  Resolves on exit code 0, rejects otherwise.
 *
 * @param {string} scriptName  Filename relative to trainer/
 * @returns {Promise<void>}
 */
function runScript(scriptName) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(TRAINER_DIR, scriptName);

    if (!fs.existsSync(VENV_PYTHON)) {
      return reject(new Error(
        `Python venv not found at ${VENV_PYTHON}. ` +
        `Run: python3 -m venv trainer/.venv && source trainer/.venv/bin/activate && pip install -r trainer/requirements.txt`
      ));
    }

    log.info(`[Trainer] ▶ ${scriptName}`);
    const proc = spawn(VENV_PYTHON, [scriptPath], {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...process.env },
    });

    proc.stdout.on('data', chunk => {
      for (const line of chunk.toString().trimEnd().split('\n')) {
        if (line.trim()) log.info(`[Trainer]   ${line}`);
      }
    });

    proc.stderr.on('data', chunk => {
      for (const line of chunk.toString().trimEnd().split('\n')) {
        if (line.trim()) log.warn(`[Trainer]   ${line}`);
      }
    });

    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} exited with code ${code}`));
    });
  });
}

/**
 * Run the full nightly training pipeline.
 * Non-fatal: any error is logged but does not crash the bot.
 */
async function runNightlyTrainer() {
  log.separator('─');
  log.info('[Trainer] Nightly ML pipeline starting...');

  try {
    await runScript('label_signals.py');
    await runScript('train.py');

    // Hot-reload model — picks up the new JSON without restarting
    mlModel.reload();
    log.info('[Trainer] Pipeline complete — model reloaded.');
  } catch (e) {
    log.warn(`[Trainer] Pipeline error (trading unaffected): ${e.message}`);
  }

  log.separator('─');
}

module.exports = { runNightlyTrainer };
