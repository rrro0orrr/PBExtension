/**
 * Removes HTML tags from a string, repeating until nothing changes.
 *
 * A single `replace(/<[^>]*>/g, "")` pass can leave a tag behind when the
 * input contains nested fragments such as `<scr<script>ipt>`, so this keeps
 * stripping until the output stops changing. The result is plain text for
 * display, not HTML that is safe to render.
 */
export function stripTags(html: string): string {
  let previous: string;
  let current = html;
  do {
    previous = current;
    current = current.replace(/<[^>]*>/g, "");
  } while (current !== previous);
  return current;
}
