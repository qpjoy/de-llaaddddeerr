// Separate persisted bounds prevent a narrow legacy window from becoming the
// new desktop's initial size, and let legacy rollback keep its own dimensions.
function mincaveWindowMinimum(workArea) {
  return {
    width: Math.min(760, workArea.width),
    height: Math.min(560, workArea.height),
  };
}

function mincaveWindowBounds(workArea, remembered = null) {
  const minimum = mincaveWindowMinimum(workArea);
  const width = Math.round(
    Math.max(minimum.width, Math.min(remembered?.width || 1120, workArea.width)),
  );
  const height = Math.round(
    Math.max(minimum.height, Math.min(remembered?.height || 760, workArea.height)),
  );
  const centerX = workArea.x + (workArea.width - width) / 2;
  const centerY = workArea.y + (workArea.height - height) / 2;
  return {
    x: Math.round(
      Math.max(
        workArea.x,
        Math.min(
          Number.isFinite(remembered?.x) ? remembered.x : centerX,
          workArea.x + workArea.width - width,
        ),
      ),
    ),
    y: Math.round(
      Math.max(
        workArea.y,
        Math.min(
          Number.isFinite(remembered?.y) ? remembered.y : centerY,
          workArea.y + workArea.height - height,
        ),
      ),
    ),
    width,
    height,
  };
}

module.exports = { mincaveWindowBounds, mincaveWindowMinimum };
