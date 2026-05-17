"use strict";

const MODE_CONFIG = {
  "7x7": {
    size: 7,
    boxRows: 1,
    boxCols: 7,
    givens: 24,
    maxScore: 700,
    minScore: 120,
    capSeconds: 300
  },
  "9x9": {
    size: 9,
    boxRows: 3,
    boxCols: 3,
    givens: 34,
    maxScore: 1200,
    minScore: 250,
    capSeconds: 900
  }
};

function shuffle(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function buildSolvedGrid(mode) {
  const config = MODE_CONFIG[mode];
  const size = config.size;
  const values = shuffle(Array.from({ length: size }, (_value, index) => index + 1));

  if (mode === "7x7") {
    const rowShift = Math.floor(Math.random() * size);
    return Array.from({ length: size }, (_row, row) =>
      Array.from({ length: size }, (_col, col) => values[(row + col + rowShift) % size])
    );
  }

  const pattern = (row, col) => (config.boxCols * (row % config.boxRows) + Math.floor(row / config.boxRows) + col) % size;
  const rowBands = shuffle([0, 1, 2]);
  const colBands = shuffle([0, 1, 2]);
  const rows = rowBands.flatMap((band) => shuffle([0, 1, 2]).map((row) => band * 3 + row));
  const cols = colBands.flatMap((band) => shuffle([0, 1, 2]).map((col) => band * 3 + col));

  return rows.map((row) => cols.map((col) => values[pattern(row, col)]));
}

function createPuzzle(mode) {
  const config = MODE_CONFIG[mode];
  const solution = buildSolvedGrid(mode);
  const size = config.size;
  const positions = shuffle(Array.from({ length: size * size }, (_value, index) => index));
  const givenSet = new Set(positions.slice(0, config.givens));
  const puzzle = solution.map((row, rowIndex) =>
    row.map((value, colIndex) => {
      const position = rowIndex * size + colIndex;
      return givenSet.has(position) ? value : 0;
    })
  );

  return {
    mode,
    config,
    puzzle,
    solution
  };
}

function calculateScore(mode, elapsedSeconds) {
  const config = MODE_CONFIG[mode];
  const capped = Math.min(Math.max(0, elapsedSeconds), config.capSeconds);
  const ratio = 1 - capped / config.capSeconds;
  return Math.round(config.minScore + (config.maxScore - config.minScore) * ratio);
}

function getConflicts(mode, values) {
  const config = MODE_CONFIG[mode];
  const conflicts = new Set();

  function addDuplicates(cells) {
    const seen = new Map();
    for (const [row, col, value] of cells) {
      if (!value) {
        continue;
      }

      if (!seen.has(value)) {
        seen.set(value, []);
      }

      seen.get(value).push([row, col]);
    }

    for (const matches of seen.values()) {
      if (matches.length > 1) {
        for (const [row, col] of matches) {
          conflicts.add(`${row}:${col}`);
        }
      }
    }
  }

  for (let row = 0; row < config.size; row += 1) {
    addDuplicates(values[row].map((value, col) => [row, col, value]));
  }

  for (let col = 0; col < config.size; col += 1) {
    addDuplicates(values.map((rowValues, row) => [row, col, rowValues[col]]));
  }

  if (mode === "9x9") {
    for (let startRow = 0; startRow < config.size; startRow += config.boxRows) {
      for (let startCol = 0; startCol < config.size; startCol += config.boxCols) {
        const cells = [];
        for (let row = startRow; row < startRow + config.boxRows; row += 1) {
          for (let col = startCol; col < startCol + config.boxCols; col += 1) {
            cells.push([row, col, values[row][col]]);
          }
        }
        addDuplicates(cells);
      }
    }
  }

  return conflicts;
}

function isComplete(mode, values, solution) {
  const config = MODE_CONFIG[mode];

  for (let row = 0; row < config.size; row += 1) {
    for (let col = 0; col < config.size; col += 1) {
      if (values[row][col] !== solution[row][col]) {
        return false;
      }
    }
  }

  return true;
}
