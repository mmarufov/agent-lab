// Eve embeds a file imported with ?raw as UTF-8 text (see Eve's asset imports).
declare module "*.md?raw" {
  const text: string;
  export default text;
}
