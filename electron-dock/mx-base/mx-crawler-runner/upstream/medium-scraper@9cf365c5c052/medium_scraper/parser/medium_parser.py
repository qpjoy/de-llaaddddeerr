from __future__ import annotations
import uuid
"""HTML to Markdown conversion utilities tailored for Medium articles.

Contains a MarkdownConverter subclass with custom rules and a parser class that
accepts raw HTML and returns a structured parse result with cleaned Markdown.
"""
import re
import json as _json

from bs4 import BeautifulSoup, NavigableString, Tag
from markdownify import MarkdownConverter

from ..models import ArticleParseResult

def normalize_title(title: str) -> str:
	"""Normalize the title to a valid filename."""
	title = title.strip()
	title = re.sub(r"[^\w\s-]", "", title)
	title = re.sub(r"\s+", "-", title)
	return title
 
class _MediumMarkdownConverter(MarkdownConverter):
	"""Custom converter rules for Medium HTML.

	Adds conversions for code blocks, line breaks, anchor normalization, figures,
	and preserves iframes as raw HTML.
	"""
	def _pick_best_src(self, srcset: str) -> str:
		# Choose the last candidate in srcset and return its URL part
		candidates = [c.strip() for c in (srcset or "").split(",") if c.strip()]
		if not candidates:
			return ""
		last = candidates[-1]
		# candidate format: "url size" or "url density"
		parts = last.split()
		return parts[0] if parts else ""

	def convert_pre(self, el, text, *args, **kwargs):
		"""Render <pre> blocks as fenced code blocks."""
		code_text = el.get_text()
		return f"```\n{code_text}\n```"

	def convert_br(self, el, text, *args, **kwargs):
		"""Convert <br> to newline."""
		return "\n"

	def convert_a(self, el, text, *args, **kwargs):
		"""Inline links with absolute Medium URLs when necessary."""
		href = el.get("href")
		if not href:
			return text or ""
		if href.startswith("/"):
			href = "https://medium.com" + href
		title = el.get("title")
		title_part = f' "{title}"' if title else ""
		label = text if text is not None else el.get_text()
		return f"[{label}]({href}{title_part})"

	def convert_figure(self, el, text, *args, **kwargs):
		"""Prefer highest-quality image from <source srcset> or nested <img> in <figure>."""
		best_src = ""
		source = el.find("source")
		if source and source.get("srcset"):
			best_src = self._pick_best_src(source.get("srcset") or "")
		if not best_src:
			img = el.find("img")
			if img is not None:
				if img.get("src"):
					best_src = img.get("src")
				elif img.get("srcset"):
					best_src = self._pick_best_src(img.get("srcset") or "")
		caption_el = el.find("figcaption")
		caption = caption_el.get_text(strip=True) if caption_el else ""
		if best_src:
			return f"![{caption}]({best_src})"
		return f"<b>[other]{caption}[/other]</b>"

	def convert_picture(self, el, text, *args, **kwargs):
		"""Handle <picture> similarly to <figure> by selecting best source or nested image."""
		best_src = ""
		if el.get("srcset"):
			best_src = self._pick_best_src(el.get("srcset") or "")
		if not best_src:
			srcset_node = el.find("source")
			if srcset_node and srcset_node.get("srcset"):
				best_src = self._pick_best_src(srcset_node.get("srcset") or "")
		if not best_src:
			img = el.find("img")
			if img is not None:
				if img.get("src"):
					best_src = img.get("src")
				elif img.get("srcset"):
					best_src = self._pick_best_src(img.get("srcset") or "")
		alt = ""
		if el.find("img") is not None and el.find("img").get("alt"):
			alt = el.find("img").get("alt") or alt
		return f"![{alt}]({best_src})" if best_src else ""

	def convert_img(self, el, text, *args, **kwargs):
		"""Convert standalone <img> to Markdown image, using srcset when needed."""
		src = el.get("src") or ""
		if not src and el.get("srcset"):
			src = self._pick_best_src(el.get("srcset") or "")
		alt = el.get("alt") or ""
		return f"![{alt}]({src})" if src else ""

	def convert_iframe(self, el, text, *args, **kwargs):
		"""Keep iframes unmodified as raw HTML."""
		return str(el)


class MediumMarkdownParser:
	"""Parses a Medium article's HTML into normalized Markdown and title."""
	def __init__(self) -> None:
		"""Initialize the parser and the custom Markdown converter."""
		self._converter = _MediumMarkdownConverter()

	def parse_html(self, html: str, source_url: str) -> ArticleParseResult:
		"""Convert article HTML into Markdown and return ArticleParseResult.

		- html: Full HTML string of a Medium post page
		- source_url: URL used for reference annotations in the output
		"""
		try:
			soup = BeautifulSoup(html, "html.parser")
			article = soup.find("article")
			if not article:
				return ArticleParseResult.failure("Error: No article found on the page.")

			# Title
			h1 = article.find("h1")
			title = ""
			# try to get title from meta tag
			meta = soup.find("meta", attrs={"name": "title"})
			if meta and meta.get("content"):
				title = meta.get("content").strip()
			if not title:
				title = h1.get_text(strip=True) if h1 else f"Untitled-Article-Title-{uuid.uuid4()}"
			title = normalize_title(title)

			# Author info (robust extraction)
			def _extract_author(_soup: BeautifulSoup) -> (str, str):
				name_candidate = None
				url_candidate = None
				# JSON-LD blocks
				for script in _soup.find_all("script", attrs={"type": "application/ld+json"}):
					try:
						text = script.string or "".join(str(c) for c in script.contents)
						if not text:
							continue
						obj = _json.loads(text)
						candidates = obj if isinstance(obj, list) else [obj]
						for entry in candidates:
							if not isinstance(entry, dict):
								continue
							auth = entry.get("author")
							if not auth:
								continue
							if isinstance(auth, list) and auth:
								auth = auth[0]
							if isinstance(auth, dict):
								if not name_candidate:
									name_candidate = (auth.get("name") or "").strip() or name_candidate
								if not url_candidate:
									url_candidate = auth.get("url") or url_candidate
								if name_candidate and url_candidate:
									break
					except Exception:
						pass
					if name_candidate and url_candidate:
						break
				# Meta tag fallback
				if not name_candidate:
					meta = _soup.find("meta", attrs={"name": "author"}) or _soup.find("meta", attrs={"property": "author"})
					if meta and meta.get("content"):
						name_candidate = meta.get("content").strip()
				# data-testid author anchor fallback
				if not name_candidate or not url_candidate:
					name_el = _soup.select_one("[data-testid='authorName']")
					if name_el:
						text_val = name_el.get_text(strip=True)
						if text_val:
							name_candidate = name_candidate or text_val
							href_val = name_el.get("href")
							if href_val:
								url_candidate = url_candidate or href_val
				# Byline anchor fallback (prefer non-empty text)
				if not name_candidate or not url_candidate:
					header = article.find("header") if article else None
					anchor = None
					if header:
						for a in header.select("a[href^='/@']"):
							text_val = a.get_text(strip=True)
							if text_val:
								anchor = a
								break
					if not anchor:
						for a in _soup.select("a[href^='/@']"):
							text_val = a.get_text(strip=True)
							if text_val:
								anchor = a
								break
					if anchor:
						if not name_candidate:
							name_candidate = anchor.get_text(strip=True)
						if not url_candidate:
							url_candidate = anchor.get("href")
				# Normalize URL
				if url_candidate and url_candidate.startswith("/"):
					url_candidate = "https://medium.com" + url_candidate
				return name_candidate or "Unknown Author", url_candidate or "#"

			author_name, author_profile = _extract_author(soup)

			# Remove third child of div.speechify-ignore.ab.cp (element children only)
			speechify_div = soup.select_one("div.speechify-ignore.ab.cp")
			if speechify_div:
				element_children = [c for c in speechify_div.children if isinstance(c, Tag)]
				if len(element_children) >= 3:
					element_children[2].decompose()

			# Add target="_blank" to all anchors
			for a in soup.find_all("a"):
				a["target"] = "_blank"

			# Move main figure after h1
			main_figure = soup.select_one("figure.paragraph-image")
			if main_figure and h1:
				main_figure.extract()
				h1.insert_after(main_figure)

			# Insert reference and author lines
			insert_after = main_figure if main_figure else h1
			if insert_after:
				p_break_top = soup.new_tag("p"); p_break_top.append(soup.new_tag("br")); insert_after.insert_after(p_break_top)
				p_ref = soup.new_tag("p"); a_ref = soup.new_tag("a", href=source_url, target="_blank"); a_ref.string = "Reference"; p_ref.append(a_ref); p_break_top.insert_after(p_ref)
				p_break_bottom = soup.new_tag("p"); p_break_bottom.append(soup.new_tag("br")); p_ref.insert_after(p_break_bottom)

			# Cleanup of non-content elements
			for img in soup.select("img[data-testid='authorPhoto']"):
				parent_a = img.find_parent("a"); (parent_a or img).decompose()
			for img in soup.select("img[data-testid='publicationPhoto']"):
				parent_a = img.find_parent("a"); (parent_a or img).decompose()
			for a in soup.select("a[href*='/m/signin']"):
				a.decompose()
			for el in soup.select("[data-testid='publicationName']"):
				parent_div = el.find_parent("div"); (parent_div or el).decompose()
			for el in soup.select("[data-testid='storyReadTime']"):
				parent_span = el.find_parent("span"); (parent_span or el).decompose()
			for el in soup.select("[data-testid='storyPublishDate']"):
				parent_span = el.find_parent("span"); (parent_span or el).decompose()
			for el in soup.select("[data-testid='authorName']"):
				el.decompose()
			for el in soup.select("[data-testid='headerClapButton']"):
				el.decompose()
			for p in soup.find_all("p"):
				if p.get_text(strip=True) == "·":
					p.decompose()
			for p in soup.find_all("p"):
				if not p.get_text(strip=True):
					p.decompose()

			# Convert to Markdown with custom rules
			raw_markdown = self._converter.convert(str(article))

			# Post-process Markdown: unescape, fix link formatting, drop noise
			markdown_cleaned = re.sub(r"\\([^a-zA-Z0-9\s])", r"\1", raw_markdown)
			markdown_cleaned = re.sub(r"\[\n+", "[", markdown_cleaned)
			markdown_cleaned = re.sub(r"\n+\]\(", "](", markdown_cleaned)
			markdown_cleaned = re.sub(r"\[\]\(", "[ ](", markdown_cleaned)

			lines = markdown_cleaned.split("\n")
			undesired = {"·", "Published in", "--", "1", "Listen", "Share"}
			filtered = []
			for idx, line in enumerate(lines):
				if idx < 40 and line.strip() in undesired:
					continue
				filtered.append(line)
			markdown_cleaned = "\n".join(filtered)

			# Normalize code fences and ensure spacing
			markdown_cleaned = re.sub(r"([^\n])```", r"\1\n```", markdown_cleaned)
			markdown_cleaned = re.sub(r"```([^\n])", r"```\n\1", markdown_cleaned)
			normalized_fence_lines = []
			for line in markdown_cleaned.split("\n"):
				if re.fullmatch(r"\s*`+\s*", line):
					line = "```"
					if normalized_fence_lines and normalized_fence_lines[-1] == "```":
						continue
				normalized_fence_lines.append(line)
			result_lines = []
			fence_is_open = False
			for line in normalized_fence_lines:
				if line == "```":
					if not fence_is_open:
						if result_lines and result_lines[-1].strip() != "":
							result_lines.append("")
						result_lines.append("```")
						fence_is_open = True
					else:
						result_lines.append("```")
						result_lines.append("")
						fence_is_open = False
				else:
					result_lines.append(line)
			while result_lines and result_lines[-1].strip() == "":
				result_lines.pop()
			markdown_cleaned = "\n".join(result_lines)

			# Merge email header block with following paragraph
			lines_pp = markdown_cleaned.split("\n")
			i = 0
			while i < len(lines_pp) - 3:
				if lines_pp[i].strip() == "```" and i + 1 < len(lines_pp) and lines_pp[i + 1].lstrip().startswith("From:"):
					j = i + 2
					while j < len(lines_pp) and lines_pp[j].strip() != "```":
						j += 1
					if j >= len(lines_pp):
						break
					k = j + 1
					while k < len(lines_pp) and lines_pp[k].strip() == "":
						k += 1
					m = k
					while m < len(lines_pp) and lines_pp[m].strip() != "```":
						m += 1
					if k < m:
						lines_pp.pop(j)
						m -= 1
						if j < len(lines_pp) and lines_pp[j].strip() != "":
							lines_pp.insert(j, ""); m += 1
						if m < len(lines_pp) and lines_pp[m].strip() == "```":
							pass
						else:
							lines_pp.insert(m, "```")
						i = m + 1
						continue
				i += 1
			markdown_cleaned = "\n".join(lines_pp)

			# Collapse excessive blank lines to a single empty line
			markdown_cleaned = re.sub(r"\n{3,}", "\n\n", markdown_cleaned)

			return ArticleParseResult.success(markdown_cleaned, title)
		except Exception as exc:
			return ArticleParseResult.failure(str(exc) or "Error parsing the article") 