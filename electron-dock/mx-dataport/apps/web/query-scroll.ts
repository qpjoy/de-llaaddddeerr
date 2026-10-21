/** The console has one visible scrollbar; never scroll its outer frame/body. */
export function resetQueryScroll(page: HTMLElement | null) {
  page?.closest<HTMLElement>(".harbor-console")?.scrollTo({
    top: 0,
    left: 0,
    behavior: "instant",
  });
}

export function revealQueryResult(result: HTMLElement | null) {
  if (!result) return;
  result.focus({ preventScroll: true });
  const content = result.closest<HTMLElement>(".harbor-console");
  if (!content) return;
  const top =
    content.scrollTop +
    result.getBoundingClientRect().top -
    content.getBoundingClientRect().top -
    content.clientTop -
    16;
  content.scrollTo({ top: Math.max(0, top), behavior: "instant" });
}
