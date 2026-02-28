import React, { useState, useEffect, useRef } from 'react';
import { Button, Spinner, Text } from '@shopify/polaris';

function FilterDropdown({ label, options, selected, onChange, multiSelect, searchable }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [dropdownStyle, setDropdownStyle] = useState({});
  const btnRef = useRef(null);
  const dropRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target) &&
        dropRef.current && !dropRef.current.contains(e.target)
      ) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropdownStyle({
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        minWidth: Math.max(rect.width, 200),
        zIndex: 9999,
      });
    }
    setOpen(!open);
  };

  const handleSelect = (value) => {
    if (multiSelect) {
      if (selected.includes(value)) {
        onChange(selected.filter(v => v !== value));
      } else {
        onChange([...selected, value]);
      }
    } else {
      onChange(selected === value ? '' : value);
      setOpen(false);
    }
  };

  const filteredOptions = options.filter(o =>
    o.toLowerCase().includes(search.toLowerCase())
  );

  const displayText = multiSelect
    ? selected.length > 0 ? `${label} (${selected.length})` : label
    : selected ? `${label}: ${selected}` : label;

  const isActive = multiSelect ? selected.length > 0 : !!selected;

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        style={{
          padding: '6px 12px',
          border: `1px solid ${isActive ? '#008060' : '#c9cccf'}`,
          borderRadius: '20px',
          background: isActive ? '#f1f8f5' : 'white',
          cursor: 'pointer',
          fontSize: '13px',
          fontWeight: isActive ? '600' : '400',
          color: isActive ? '#008060' : '#202223',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          whiteSpace: 'nowrap',
        }}
      >
        {displayText} <span style={{ fontSize: '10px' }}>▾</span>
      </button>

      {open && (
        <div
          ref={dropRef}
          style={{
            ...dropdownStyle,
            background: 'white',
            border: '1px solid #c9cccf',
            borderRadius: '8px',
            maxHeight: '320px',
            minHeight: '120px',
            overflowY: 'auto',
            boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          }}
        >
          {searchable && (
            <div style={{ padding: '8px', borderBottom: '1px solid #f1f3f5', position: 'sticky', top: 0, background: 'white' }}>
              <input
                type="text"
                placeholder={`Search ${label.toLowerCase()}...`}
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
                style={{
                  width: '100%', padding: '6px 10px',
                  border: '1px solid #c9cccf', borderRadius: '6px',
                  fontSize: '13px', boxSizing: 'border-box',
                }}
              />
            </div>
          )}
          {filteredOptions.length === 0 && (
            <div style={{ padding: '12px', color: '#6d7175', fontSize: '13px' }}>No results</div>
          )}
          {filteredOptions.map(opt => {
            const checked = multiSelect ? selected.includes(opt) : selected === opt;
            return (
              <div
                key={opt}
                onClick={() => handleSelect(opt)}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: checked ? '#f1f8f5' : 'white',
                  borderBottom: '1px solid #f6f6f7',
                  fontSize: '13px',
                }}
              >
                {multiSelect ? (
                  <input type="checkbox" checked={checked} onChange={() => {}} style={{ cursor: 'pointer' }} />
                ) : (
                  <span style={{
                    width: '14px', height: '14px', borderRadius: '50%',
                    border: `2px solid ${checked ? '#008060' : '#c9cccf'}`,
                    background: checked ? '#008060' : 'white',
                    display: 'inline-block', flexShrink: 0,
                  }} />
                )}
                {opt}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SearchWithFilters({ onAddItems, taskItems }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const [dropStyle, setDropStyle] = useState({});

  // Filters
  const [allVendors, setAllVendors] = useState([]);
  const [allTags, setAllTags] = useState([]);
  const [selectedVendors, setSelectedVendors] = useState([]);
  const [selectedTag, setSelectedTag] = useState('');

  const inputRef = useRef(null);
  const dropRef = useRef(null);
  const wrapperRef = useRef(null);

  // Load vendors and tags on mount
  useEffect(() => {
    const loadFilters = async () => {
      try {
        const res = await fetch('/api/shopify/vendors-tags');
        const data = await res.json();
        setAllVendors(data.vendors || []);
        setAllTags(data.tags || []);
      } catch (e) {
        console.error('Failed to load filters');
      }
    };
    loadFilters();
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (
        wrapperRef.current && !wrapperRef.current.contains(e.target) &&
        dropRef.current && !dropRef.current.contains(e.target)
      ) {
        setDropOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Debounced search
  useEffect(() => {
    if (query.trim().length < 3 && selectedVendors.length === 0 && !selectedTag) {
      setResults([]);
      setDropOpen(false);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (query.trim().length >= 3) params.append('q', query.trim());
        if (selectedVendors.length > 0) params.append('vendors', selectedVendors.join(','));
        if (selectedTag) params.append('tag', selectedTag);

        const res = await fetch(`/api/shopify/search?${params.toString()}`);
        const data = await res.json();
        setResults(data);

        if (inputRef.current) {
          const rect = inputRef.current.getBoundingClientRect();
          setDropStyle({
            position: 'fixed',
            top: rect.bottom + 4,
            left: rect.left,
            width: rect.width,
            zIndex: 9999,
          });
        }
        setDropOpen(true);
      } catch (e) {
        console.error('Search failed');
      } finally {
        setLoading(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [query, selectedVendors, selectedTag]);

  const toggleSelect = (barcode) => {
    setSelected(prev =>
      prev.includes(barcode) ? prev.filter(x => x !== barcode) : [...prev, barcode]
    );
  };

  const handleAdd = () => {
    const toAdd = results.filter(p => selected.includes(p.barcode));
    onAddItems(toAdd);
    setSelected([]);
    setQuery('');
    setDropOpen(false);
  };

  return (
    <div ref={wrapperRef}>
      {/* Filter chips */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <FilterDropdown
          label="Vendors"
          options={allVendors}
          selected={selectedVendors}
          onChange={setSelectedVendors}
          multiSelect={true}
          searchable={true}
        />
        <FilterDropdown
          label="Tag"
          options={allTags}
          selected={selectedTag}
          onChange={setSelectedTag}
          multiSelect={false}
          searchable={true}
        />
        {(selectedVendors.length > 0 || selectedTag) && (
          <button
            onClick={() => { setSelectedVendors([]); setSelectedTag(''); }}
            style={{
              padding: '6px 12px', border: 'none', background: 'none',
              cursor: 'pointer', fontSize: '13px', color: '#d72c0d',
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Search input */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search by title, name or SKU (min 3 chars)..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setDropOpen(true)}
          style={{
            flex: 1, padding: '8px 12px',
            border: '1px solid #c9cccf', borderRadius: '8px',
            fontSize: '14px',
          }}
        />
        {loading && <Spinner size="small" />}
        {selected.length > 0 && (
          <Button onClick={handleAdd}>Add {selected.length}</Button>
        )}
      </div>

      {/* Search results dropdown */}
      {dropOpen && (
        <div
          ref={dropRef}
          style={{
            ...dropStyle,
            background: 'white',
            border: '1px solid #c9cccf',
            borderRadius: '8px',
            maxHeight: '320px',
            minHeight: '80px',
            overflowY: 'auto',
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          }}
        >
          {results.length === 0 && !loading && (
            <div style={{ padding: '16px', color: '#6d7175', fontSize: '13px', textAlign: 'center' }}>
              No products found
            </div>
          )}
          {results.map(p => (
            <div
              key={p.barcode}
              onClick={() => toggleSelect(p.barcode)}
              style={{
                padding: '10px 12px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '8px',
                background: selected.includes(p.barcode) ? '#f1f8f5' : 'white',
                borderBottom: '1px solid #f1f3f5',
              }}
            >
              <input
                type="checkbox"
                checked={selected.includes(p.barcode)}
                onChange={() => {}}
                style={{ cursor: 'pointer' }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '14px', fontWeight: '500' }}>{p.name}</div>
                <div style={{ fontSize: '12px', color: '#6d7175' }}>{p.barcode}</div>
              </div>
              {taskItems.includes(p.barcode) && (
                <span style={{ color: '#008060', fontSize: '12px', fontWeight: '600' }}>✓ Added</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default SearchWithFilters;