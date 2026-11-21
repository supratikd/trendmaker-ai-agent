export interface SceneSource {
  videoId: string;
  durationSeconds: number;
}

export interface AllocatedSceneSource {
  videoId: string | null;
  durationSeconds: number;
}

export function allocateSceneSourceDurations(
  sceneNumber: number,
  sceneDurationSeconds: number,
  sources: readonly SceneSource[],
): AllocatedSceneSource[] {
  if (!Number.isSafeInteger(sceneDurationSeconds) || sceneDurationSeconds <= 0) {
    throw new Error(`Scene ${sceneNumber} must have a positive integer duration.`);
  }
  if (sources.length === 0) {
    return [{ videoId: null, durationSeconds: sceneDurationSeconds }];
  }
  if (sources.length > sceneDurationSeconds) {
    throw new Error(`Scene ${sceneNumber} has more source videos than available seconds.`);
  }
  if (new Set(sources.map((source) => source.videoId)).size !== sources.length) {
    throw new Error(`Scene ${sceneNumber} contains duplicate source video IDs.`);
  }
  if (sources.some((source) =>
    !Number.isSafeInteger(source.durationSeconds) || source.durationSeconds <= 0
  )) {
    throw new Error(`Scene ${sceneNumber} contains a source with an invalid duration.`);
  }

  const totalSourceDuration = sources.reduce((total, source) => total + source.durationSeconds, 0);
  if (totalSourceDuration < sceneDurationSeconds) {
    throw new Error(
      `Scene ${sceneNumber} needs ${sceneDurationSeconds}s, but its selected sources ` +
      `provide only ${totalSourceDuration}s in total.`,
    );
  }

  const allocations = sources.map(() => 0);
  let remaining = sceneDurationSeconds;
  let activeIndices = sources.map((_, index) => index);
  while (remaining > 0) {
    const evenShare = Math.floor(remaining / activeIndices.length);
    const extraSeconds = remaining % activeIndices.length;
    for (const [activePosition, sourceIndex] of activeIndices.entries()) {
      const desired = evenShare + (activePosition < extraSeconds ? 1 : 0);
      const available = sources[sourceIndex].durationSeconds - allocations[sourceIndex];
      const allocated = Math.min(desired, available);
      allocations[sourceIndex] += allocated;
      remaining -= allocated;
    }
    activeIndices = activeIndices.filter(
      (index) => allocations[index] < sources[index].durationSeconds,
    );
  }

  return sources.map((source, index) => ({
    videoId: source.videoId,
    durationSeconds: allocations[index],
  }));
}
