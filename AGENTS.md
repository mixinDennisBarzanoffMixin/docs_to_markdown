# Shared OCR workspace rules

`documents_in/`, `markdown_out/`, and `.docproc_state*.json` are temporary shared
workspace artifacts. They must not retain files from completed jobs.

For every OCR job:

1. Run `bun run reset:all` before adding the new source document.
2. Rasterize and process the source in this repository.
3. Create a dedicated, descriptively named directory in the source case/project.
4. Move the original PDF plus the generated JPG and Markdown files into that
   project directory. Use the OCR-generated date-first names (`YYYY.MM.DD_...`)
   for page artifacts; do not replace them with generic names.
5. Run `bun run reset:all` again after the move and verify `documents_in/` and
   `markdown_out/` are empty.

Do not delete, overwrite, or mix another active job's files. If either workspace
directory is non-empty at the start, inspect it before resetting.

## Finishing changes

The user expects completed, authorized changes to be committed and pushed to the
existing remote branch. Verify that the remote contains the commit. Stage only
task-related files and preserve unrelated changes. Push source-case imports in
their own repository as well; do not commit temporary OCR workspace artifacts.
