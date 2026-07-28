import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import type { ArtifactRef } from "../core/types.js";

export interface ToolResultEncoding {
  readonly content: string;
  readonly output: unknown;
  readonly truncated?: boolean;
  readonly originalBytes?: number;
  readonly artifact?: ArtifactRef;
}

export interface ToolResultEncodingOptions {
  readonly maxBytes?: number;
  readonly artifactThresholdBytes?: number;
}

const DEFAULT_PREVIEW_BYTES = 512;

export async function encodeToolOutput(
  output: unknown,
  options: ToolResultEncodingOptions = {},
): Promise<ToolResultEncoding> {
  const serialized = serializeOutput(output);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  const maxBytes = options.maxBytes;

  if (maxBytes !== undefined && originalBytes > maxBytes) {
    const artifact = await createTempArtifact(serialized, originalBytes);
    return {
      content: `[artifact stored: id=${artifact.artifactId}, mediaType=${artifact.mediaType}, bytes=${artifact.bytes}]`,
      output: artifact,
      truncated: true,
      originalBytes,
      artifact,
    };
  }

  return {
    content: serialized,
    output,
    ...(originalBytes > DEFAULT_PREVIEW_BYTES ? { originalBytes } : {}),
  };
}

function serializeOutput(output: unknown): string {
  if (typeof output === "string") return output;

  try {
    const serialized = JSON.stringify(output);
    return serialized ?? String(output);
  } catch {
    return String(output);
  }
}

async function createTempArtifact(content: string, bytes: number): Promise<ArtifactRef> {
  const artifactId = randomUUID();
  const path = join(tmpdir(), `mingxu-artifact-${artifactId}.json`);
  await writeFile(path, content, "utf8");
  return {
    kind: "artifact_ref",
    artifactId,
    mediaType: "application/json",
    bytes,
    storage: "local-temp",
    path,
    temporary: true,
    previewText: content.slice(0, DEFAULT_PREVIEW_BYTES),
  };
}
