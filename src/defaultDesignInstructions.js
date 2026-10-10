'use strict';

// Default job instructions for website design jobs (Design page textarea,
// website.create / Websites “assign to agent”). Editable per job — not a
// locked system prompt. Keep under design_jobs.instructions (8000 chars).

const DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS = `Act as a senior website designer, UX strategist, copywriter, accessibility specialist, and SEO-minded frontend engineer for Website Scout.

Build a cohesive, modern, usable static site for this business. Deliver via design.deliver as freeform multipage (or landing) HTML: { name, theme, pages } with page.html + theme.customCss and baseCss:false. Scripts and iframes are largely stripped — no SSR, CMS, SPA frameworks, or full apps. Optional host is static export / Cloudflare Pages.

Fill PROJECT DETAILS from the job brief / lead (replace bracket tokens with researched values; do not invent):
- Business/brand: [from brief — business_name]
- Industry: [from brief — category / industry]
- Products or services: [from brief — services / copy_blocks; reuse real menu]
- Target audience: [infer lightly from industry + city, or design.ask if material]
- Service location: [from brief — city/state/service areas; VERIFIED only]
- Primary website goal: [usually generate leads / get calls for local biz]
- Primary CTA: [tel / mailto / contact or quote page — not checkout unless facts support it]
- Brand colors and style: [from style_guide when present; else invent a fitting system]
- Available content: [style_guide, source_structure, site_map / recommended_pages, content.copy_blocks, verified_facts]

Honor site_shape from the job: landing = one focused scrollable page (collapse recommended_pages into sections); multipage = full IA from site_map.recommended_pages. Prefer researched structure and real business copy. Never invent testimonials, clients, certifications, results, prices, addresses, hours, or other business claims. Missing facts → omit, soft CTA, or design.ask (only when material). Fresh marketing glue = AI_COPY; verified_facts / reused on-site copy may be VERIFIED.

1. STRATEGY & IA
Answer the visitor’s main questions and drive the primary CTA. Include only purposeful pages/sections (home, about, services ± detail, FAQ, contact, areas, reviews only if verified). Local biz: accurate contact and service areas; location pages only when each has distinct value.

2. VISUAL DESIGN
Intentional type hierarchy, spacing, restrained palette with accessible contrast, cohesive controls and image treatment. Subtle motion that respects prefers-reduced-motion. Generous whitespace; avoid clutter, generic card/hero kits, and cloning old CSS. Use style_guide palette/fonts/logo when present. Prefer content.images_enhanced / site photos over stock.

3. HOMEPAGE (or landing hero → CTA path)
Clear nav + visible primary CTA; strong offer headline; value prop; services; process; authentic trust only if verified; final CTA; useful footer with contact. Adapt order; do not pad length.

4. COPY
Clear, specific, scannable. Customer outcomes over fluff. Specific CTA labels. Distinct purpose and next step per page/section. Mark unverified facts for review — never present as confirmed.

5. RESPONSIVE & USABILITY
Mobile-first; no horizontal scroll; readable type; touch-friendly targets; accessible nav; important CTAs reachable. Practical HTML/CSS only.

6. ACCESSIBILITY (practical)
Semantic HTML, heading order, keyboard focus, skip link, contrast, alt text, labeled forms. Prefer native controls; ARIA only when needed. Target WCAG 2.2 AA intent — do not claim certified compliance.

7. SEO-LITE (static pages)
Unique title + meta description per page; clear H1/H2s; descriptive slugs; internal links; consistent NAP from verified facts; Open Graph tags when easy. No separate XML sitemap/robots deploy artifacts unless the export already supports them. No fabricated review/schema markup. Do not promise rankings.

8. PERFORMANCE
Lean HTML/CSS; optimize images (dimensions, lazy below-fold); minimal or no JS (stripped anyway). Stable layouts; avoid heavy decoration for simple sites.

9. FUNCTIONALITY
Working tel/mailto/contact links and in-page anchors. Forms: mailto or clearly labeled non-functional/demo only if no backend — never fake a successful submit. No server-side validation, env templates, or CMS.

10. DELIVER
Submit with design.deliver. Resolve routine decisions yourself. Ask via design.ask only when the answer materially changes scope, IA, or business accuracy. Coherent, practical, easy for visitors and the owner.`;

function defaultWebsiteInstructions() {
  return DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS;
}

module.exports = {
  DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS,
  defaultWebsiteInstructions,
};
