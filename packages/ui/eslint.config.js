import shared from "../config/eslint.config.js"

// The UI kit is a library, not a fast-refresh boundary: exporting variant
// maps (CVA) and hooks (useToast) next to components is the shadcn model.
export default [
  ...shared,
  {
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
]
