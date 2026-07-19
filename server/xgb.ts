import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { multiVsXgbWeight } from "./multiSignal.js";
import type { ScoreConfidence, ScoreMethod } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT = path.join(__dirname, "ml", "score_xgb.py");

export interface XgbFacilityInput {
  id: string;
  /** Multi-signal (preferred) or Benford target for training. */
  targetScore: number | null;
  benfordScore?: number | null;
  confidence: ScoreConfidence;
  features: Record<string, number>;
}

export interface XgbResult {
  xgbEnabled: boolean;
  trainedOn: number;
  predictions: Record<string, number>;
  error?: string;
  message?: string;
}

function runPython(pythonCmd: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCmd, [SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (stdout.trim()) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `Python exited ${code}: ${stderr.slice(0, 500) || "no output"}`,
        ),
      );
    });

    child.stdin.write(payload, "utf8");
    child.stdin.end();
  });
}

export async function runXgbScoring(
  facilities: XgbFacilityInput[],
): Promise<XgbResult> {
  if (facilities.length === 0) {
    return { xgbEnabled: false, trainedOn: 0, predictions: {} };
  }

  const payload = JSON.stringify({ facilities });
  const candidates =
    process.platform === "win32"
      ? ["python", "py", "python3"]
      : ["python3", "python"];

  let lastError = "python not found";

  for (const cmd of candidates) {
    try {
      const stdout = await runPython(cmd, payload);
      const parsed = JSON.parse(stdout) as {
        ok?: boolean;
        xgbEnabled?: boolean;
        trainedOn?: number;
        predictions?: Record<string, number>;
        error?: string;
        message?: string;
      };

      return {
        xgbEnabled: Boolean(parsed.xgbEnabled),
        trainedOn: parsed.trainedOn ?? 0,
        predictions: parsed.predictions ?? {},
        error: parsed.error,
        message: parsed.message,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  console.warn("[xgb] unavailable:", lastError);
  return {
    xgbEnabled: false,
    trainedOn: 0,
    predictions: {},
    error: lastError,
  };
}

/**
 * Blend multi-signal score with XGBoost using adaptive multi-vs-XGB weight.
 * Strong Benford samples (high n) → trust multi more; sparse → let XGB smooth.
 */
export function blendScores(
  multiScore: number | null,
  multiConfidence: ScoreConfidence,
  xgbScore: number | null,
  xgbEnabled: boolean,
  sampleCount = 0,
): {
  fraudChance: number | null;
  confidence: ScoreConfidence;
  scoreMethod: ScoreMethod;
} {
  if (xgbEnabled && xgbScore != null && multiScore != null) {
    const wMulti = multiVsXgbWeight(sampleCount, multiConfidence);
    const blended = Math.round(wMulti * multiScore + (1 - wMulti) * xgbScore);
    return {
      fraudChance: blended,
      confidence: multiConfidence === "none" ? "model" : multiConfidence,
      scoreMethod: "multi+xgb",
    };
  }

  if (multiScore != null) {
    return {
      fraudChance: multiScore,
      confidence: multiConfidence === "none" ? "low" : multiConfidence,
      scoreMethod: "multi",
    };
  }

  if (xgbEnabled && xgbScore != null) {
    return {
      fraudChance: Math.round(xgbScore),
      confidence: "model",
      scoreMethod: "xgb",
    };
  }

  return {
    fraudChance: null,
    confidence: "none",
    scoreMethod: "none",
  };
}
