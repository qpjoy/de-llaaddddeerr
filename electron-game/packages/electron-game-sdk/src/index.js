"use strict";

function readLaunchContext(env = process.env) {
  if (env.QPJOY_GAME_CONTEXT) {
    try {
      const context = JSON.parse(env.QPJOY_GAME_CONTEXT);
      if (context && typeof context === "object") {
        return context;
      }
    } catch {
      return {};
    }
  }

  if (env.QPJOY_MARKET_USER_ID || env.QPJOY_MARKET_USER_NAME) {
    return {
      user: {
        id: env.QPJOY_MARKET_USER_ID || env.QPJOY_MARKET_USER_NAME,
        displayName: env.QPJOY_MARKET_USER_NAME || env.QPJOY_MARKET_USER_ID,
        source: "market"
      }
    };
  }

  return {};
}

function makeFourDigitSuffix(random = Math.random) {
  return String(Math.floor(1000 + random() * 9000));
}

function normalizeDisplayName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 32);
}

function buildLocalPlayerName(baseName, random = Math.random) {
  const normalized = normalizeDisplayName(baseName);
  const safeName = normalized || "Player";
  return `${safeName}#${makeFourDigitSuffix(random)}`;
}

module.exports = {
  buildLocalPlayerName,
  makeFourDigitSuffix,
  normalizeDisplayName,
  readLaunchContext
};
