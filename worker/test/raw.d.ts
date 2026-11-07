// Vite's ?raw imports (file contents as a string), used by tests to read config files.
declare module "*?raw" {
  const text: string;
  export default text;
}
