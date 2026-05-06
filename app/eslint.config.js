// ESLint flat config for the touchgrass RN app. Extends Expo's recommended config.

const expoConfig = require("eslint-config-expo/flat");

module.exports = [
  ...expoConfig,
  {
    ignores: ["node_modules", ".expo", "dist", "ios", "android"],
  },
];
