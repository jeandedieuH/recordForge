import shared from "../../packages/config/eslint.config.js"

export default [
  ...shared,
  {
    ignores: ["convex/_generated/**", "dist/**", ".convex/**"],
  },
  {
    rules: {
      // TanStack routes export both a `Route` config object and the page component.
      "react-refresh/only-export-components": "off",
    },
  },
]
