import shared from "../../packages/config/eslint.config.js"

// Desktop features often export helper functions and option maps alongside
// components. Fast refresh for these files is not worth splitting exports into
// separate modules.
export default [
  ...shared,
  {
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
]
