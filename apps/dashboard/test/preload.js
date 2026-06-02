import { plugin } from "bun";

plugin({
  name: "css-text",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async ({ path }) => {
      const text = await Bun.file(path).text();
      return {
        contents: `export default ${JSON.stringify(text)}`,
        loader: "js",
      };
    });
  },
});
