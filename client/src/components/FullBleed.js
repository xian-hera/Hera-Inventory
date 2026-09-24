import React, { useLayoutEffect, useRef, useState } from 'react';

// Lets one block (e.g. a wide table) span the full window width while the
// rest of the page stays inside the normal fixed-width Polaris Page
// (2026-09-24, Hera: only the tables on Import Products / New products are
// full width). Measures where the page column starts and pulls the block
// out to the window edges (minus a 16px gutter each side), using the
// document's client width so the vertical scrollbar never causes a
// horizontal page scroll.
const GUTTER = 16;

function FullBleed({ children }) {
  const ref = useRef(null);
  const [style, setStyle] = useState({});

  useLayoutEffect(() => {
    const update = () => {
      const el = ref.current;
      if (!el || !el.parentElement) return;
      const parentLeft = el.parentElement.getBoundingClientRect().left;
      const pageWidth = document.documentElement.clientWidth;
      setStyle({ marginLeft: GUTTER - parentLeft, width: pageWidth - GUTTER * 2 });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return <div ref={ref} style={{ ...style, boxSizing: 'border-box' }}>{children}</div>;
}

export default FullBleed;
