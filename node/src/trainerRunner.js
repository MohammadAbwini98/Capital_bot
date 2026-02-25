// ==============================================================
// GoldBot — trainerRunner.js
// Runs the Python ML training pipeline from within Node.js.
//
// Two jobs:
//   runLabeler()       — label_signals.py only  (runs every 30 min)
//   runNightlyTrainer()— full pipeline: label → train → promote
//                        (runs once at 00:30 UTC)
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
 * Run label_signals.py only — lightweight, runs every 30 minutes.
 * Keeps the labels table current throughout the trading day so that
 * signals have fresh labels when the nightly trainer fires.
 * Non-fatal: any error is logged but does not crash the bot.
 */
async function runLabeler() {
  try {
    await runScript('label_signals.py');
  } catch (e) {
    log.warn(`[Trainer] Labeler error (non-fatal): ${e.message}`);
  }
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
    await runScript('promote.py');

    // Hot-reload model — picks up the new champion (if promoted) without restarting
    mlModel.reload();
    log.info('[Trainer] Pipeline complete — model reloaded.');
  } catch (e) {
    log.warn(`[Trainer] Pipeline error (trading unaffected): ${e.message}`);
  }

  log.separator('─');
}

module.exports = { runLabeler, runNightlyTrainer };
