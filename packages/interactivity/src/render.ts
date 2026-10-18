import {
	Fragment,
	h,
	hydrate,
	render,
	type ComponentChild,
	type ContainerNode,
	type VNode,
} from 'preact';
import { parseDirectiveValue, toVdom } from './vdom';
import { Directives, isDefaultDirectiveSuffix } from './hooks';
import { getRegionRootFragment, hydrateRegion } from './hydration';
import { getRegionId, routerRegions } from './directives/router-region';
import { warn } from './utils';

/**
 * Tree-first dynamic content rendering.
 *
 * The island's Preact tree is the single source of truth: new content is
 * parsed to vdom (detached) and spliced into the tree, then `render()` diffs
 * it in. The DOM is created by Preact — never adopted after the fact — so
 * component state survives re-renders and removed content unmounts cleanly.
 * The splice rebuilds only the path from the root to the insertion point,
 * sharing every other vnode by reference (Preact's `_original` bailout),
 * so the cost is O(depth + siblings), not O(island).
 */

type Mode = 'append' | 'prepend' | 'before' | 'after' | 'inner' | 'replace';

// Preact internal property accessor: `__k` is a vnode's rendered children
// (`__e`, read in getPathTo, is its DOM node).
const vdomChildren = ( vnode: any ): any[] => vnode?.__k ?? [];

// A rendered container (fragment) stores its tree as a single Fragment vnode
// on the same property names — NOT as an array.
const getFragmentRoot = ( fragment: any ): any => fragment?.__k ?? null;

// The attribute that marks an interactive island boundary.
const islandAttribute = 'data-wp-interactive';
const islandSelector = `[${ islandAttribute }]`;

// Synthetic-key counter (see spliceIntoTree): monotonically increasing so
// successive splices never collide; the prefix is reserved so user
// `data-wp-key` values can never collide with it.
let syntheticKeyId = 0;
const syntheticKeyPrefix = 'wpiapi-synthetic-';

// Assigns a key fallback to a top-level vnode being spliced in: a user
// `data-wp-key` (already on `vnode.key`) wins, then the element's `id` (a
// stable, server-visible name: refreshed HTML carrying the same id matches
// the existing item — identity across refreshes, reorders, and duplicate
// deliveries), then — for INSERTION modes only — a unique synthetic key so
// the new item mounts fresh instead of being absorbed into the existing
// item at its index (which would swallow the new item's data-wp-init and
// re-run an existing item's). `inner`/`replace` get no synthetic key: they
// are wholesale swaps where positional reuse is the desired default.
// Directive-wrapped vnodes keep their real props in `originalProps`.
const applyKeyFallback = ( vnode: any, allowSynthetic: boolean ): void => {
	// Nullish on purpose: preact vnodes may carry key null (no key) or
	// undefined.
	// eslint-disable-next-line eqeqeq
	if ( vnode.key != null ) {
		return;
	}
	const realProps = vnode.props?.originalProps ?? vnode.props;
	const id = realProps?.id;
	if ( typeof id === 'string' && id !== '' ) {
		vnode.key = id;
	} else if ( allowSynthetic ) {
		vnode.key = syntheticKeyPrefix + ( syntheticKeyId += 1 );
	}
};

/**
 * Returns the OUTERMOST `data-wp-interactive` boundary — the island whose
 * tree owns the element's subtree. `hydrateRegions` only hydrates outermost
 * islands and nested ones render as part of the outer island's tree, so
 * spliced content must go through the outermost tree. Returns `null` if
 * there is no island.
 *
 * @param element The element to locate.
 * @return The outermost island element, or `null`.
 */
const getTreeIsland = ( element: Element ): Element | null => {
	let island = element.closest( islandSelector );
	while ( island ) {
		// `closest()` includes the element it starts at, so start from the
		// parent to find the nearest island strictly outside this one.
		const outer = island.parentElement?.closest( islandSelector ) ?? null;
		if ( ! outer ) {
			return island;
		}
		island = outer;
	}
	return null;
};

/**
 * Parses an island's `data-wp-interactive` value into its namespace, with
 * the same parser and rules as `toVdom`: a plain string verbatim, an
 * object's `namespace` string, anything else `null`.
 *
 * @param island The island element.
 * @return The island's namespace, or `null`.
 */
const getIslandNamespace = ( island: Element ): string | null => {
	const { value } = parseDirectiveValue(
		island.getAttribute( islandAttribute ) ?? ''
	);
	if ( typeof value === 'string' ) {
		return value;
	}
	return typeof value?.namespace === 'string' ? value.namespace : null;
};

/**
 * Finds the path of vnodes from the tree root down to the vnode that
 * rendered `target` (root → container, inclusive) by walking the current
 * rendered tree. Element vnodes are only entered when their DOM node is an
 * ancestor of `target`; component vnodes (Directives, Provider, Fragment)
 * have no DOM node of their own and are always entered. The cost is
 * O(depth × siblings), the same order as the path rebuild that follows,
 * and nothing has to be recorded during regular renders.
 *
 * Because the walk starts at the current root, an element that is in the
 * DOM but not in the tree (e.g. removed by a splice and re-inserted with
 * raw DOM calls) is never found.
 *
 * @param root   The tree root vnode (the island vnode).
 * @param target The container element.
 * @return The path of vnodes from the root to the container, or `null`.
 */
const getPathTo = ( root: any, target: Element ): any[] | null => {
	const ancestors = new Set< Node >();
	for ( let node: Node | null = target; node; node = node.parentNode ) {
		ancestors.add( node );
	}
	const reversed: any[] = [];
	const walk = ( vnode: any ): boolean => {
		if ( typeof vnode.type === 'string' ) {
			if ( vnode.__e === target ) {
				reversed.push( vnode );
				return true;
			}
			if ( ! ancestors.has( vnode.__e ) ) {
				return false;
			}
		} else if ( typeof vnode.type !== 'function' ) {
			// Text vnodes.
			return false;
		}
		for ( const child of vdomChildren( vnode ) ) {
			if ( child && walk( child ) ) {
				reversed.push( vnode );
				return true;
			}
		}
		return false;
	};
	return walk( root ) ? reversed.reverse() : null;
};

/**
 * Rebuilds a vnode on the path to the insertion point.
 *
 * - String (element) vnodes: recreated with the new children array.
 * - `Directives` wrappers: recreated with the rebuilt element as their
 *   `element` prop — re-running the component re-wraps it in the directive /
 *   Provider chain, propagating the change.
 * - Other components: rebuilt with `children` (best effort — only
 *   transparent pass-through wrappers like `Provider` are expected).
 *
 * @param pathNode     The vnode to rebuild.
 * @param child        The rebuilt vnode occupying this node's child slot.
 * @param childVNode   The ORIGINAL vnode at that slot (to locate its index —
 *                     siblings must survive the rebuild).
 * @param chainElement The rebuild of the deepest string vnode in this node's
 *                     rendered chain (the `element` prop for Directives).
 * @return The rebuilt vnode.
 */
const rebuildPathNode = (
	pathNode: any,
	child: any,
	childVNode: any,
	chainElement: any
): any => {
	// The key must be carried over explicitly (preact reads it only from
	// props.key, and the original key lives on the vnode itself, not in
	// props): a keyed node on the path that loses its key cannot match the
	// old keyed vnode, so it would remount — re-running its data-wp-init
	// and resetting its context.
	const propsWithKey = { ...pathNode.props, key: pathNode.key };
	if ( typeof pathNode.type === 'string' ) {
		const oldChildren = vdomChildren( pathNode );
		const idx = oldChildren.indexOf( childVNode );
		const newChildren = [ ...oldChildren ];
		if ( idx !== -1 ) {
			// Replace only the child slot occupied by the rebuilt vnode —
			// the node's siblings must survive the rebuild.
			newChildren[ idx ] = child;
		} else {
			// Should not happen (the path child is always a rendered child);
			// fall back to appending.
			newChildren.push( child );
		}
		return h( pathNode.type, { ...propsWithKey, children: newChildren } );
	}
	if ( pathNode.type === Directives ) {
		return h( Directives, { ...propsWithKey, element: chainElement } );
	}
	return h( pathNode.type, { ...propsWithKey, children: [ child ] } );
};

/**
 * Mirrors a spliced region element into its router signal (write-through).
 *
 * A splice rebuilds the path through the region's `router-region`
 * `Directives` level, whose render re-runs the callback and re-reads the
 * signal — if it still holds the PRE-splice vnode, the splice is reverted
 * during its own render (a silent no-op). Writing the rebuilt region content
 * into the signal first makes it stick; the signal then mirrors the tree.
 *
 * Only NAVIGATED regions are written (signal holds a vnode). SSR regions
 * (`undefined`) render the tree's children directly; hidden regions (`null`)
 * have no content to splice into.
 *
 * @param wrapper     The rebuilt `Directives` wrapper whose CURRENT priority
 *                    level is the `router-region` directive.
 * @param regionVnode The rebuilt content the wrapper renders — the same
 *                    shape `cloneRouterRegionContent` produces.
 */
const writeRegionSignal = ( wrapper: any, regionVnode: any ): void => {
	const entries: any[] = wrapper.props?.directives?.[ 'router-region' ];
	const entry = entries?.find( isDefaultDirectiveSuffix );
	if ( ! entry || entry.uniqueId ) {
		return;
	}
	const regionId = getRegionId( entry );
	if ( ! regionId ) {
		return;
	}
	const signal = routerRegions.get( regionId );
	if ( signal && signal.value ) {
		signal.value = regionVnode;
	}
};

/**
 * Locates (and if needed hydrates) the island tree, then splices the new
 * vnodes into it at the mode described by `mode` relative to `container`,
 * and renders the rebuilt tree.
 *
 * @param island    The island whose tree receives the splice.
 * @param container The element the mode is relative to.
 * @param mode      Insert mode.
 * @param newVdoms  The vnodes to insert.
 */
const spliceIntoTree = (
	island: Element,
	container: Element,
	mode: Mode,
	newVdoms: ComponentChild[]
): void => {
	// Key the new top-level vnodes (the direct children of the container).
	// A user `data-wp-key` wins, then the element's `id`, then — for
	// INSERTION modes only (prepend/before/after) — a unique synthetic
	// key so the new item mounts fresh instead of being absorbed into the
	// existing item at its index. `inner`/`replace` get no synthetic key:
	// positional reuse is the desired default for wholesale swaps. Text
	// nodes are plain strings and are skipped.
	const indexShifting =
		mode === 'prepend' || mode === 'before' || mode === 'after';
	for ( const vdom of newVdoms ) {
		if ( ! vdom || typeof vdom !== 'object' ) {
			continue;
		}
		applyKeyFallback( vdom as any, indexShifting );
	}

	const fragment = getRegionRootFragment( [ island ] ) as any;
	let root = getFragmentRoot( fragment );
	if ( ! root ) {
		// The island has no tree yet (not hydrated): adopt the existing DOM —
		// the only sanctioned adoption path, a fragment's first render. Going
		// through `hydrateRegion` marks the island as hydrated, so
		// `hydrateRegions` skips it instead of hydrating it a second time.
		hydrateRegion( island );
		root = getFragmentRoot( fragment );
	}
	if ( ! root ) {
		warn(
			'renderHTML(): the island tree could not be found. Is the island hydrated?'
		);
		return;
	}

	// The fragment's root is Preact's artificial Fragment wrapper; the island
	// vnode is its only child. Locate the container from the island vnode
	// down so the path is [island, ..., container] — never
	// includes the wrapper (rebuilding it would nest a Fragment that cannot
	// type-match the island element, remounting the whole tree).
	const treeRoot = vdomChildren( root )[ 0 ] ?? root;
	const path = getPathTo( treeRoot, container );
	if ( ! path || path.length === 0 ) {
		warn(
			'renderHTML(): the container could not be located in the island tree. Is it inside a data-wp-each list or a template?'
		);
		return;
	}

	let current: any;
	let chainElement: any;
	let startIdx: number;

	if ( mode === 'inner' || mode === 'append' || mode === 'prepend' ) {
		// Splice into the container's own children.
		const target = path[ path.length - 1 ];
		const oldChildren = vdomChildren( target );
		let newChildren: ComponentChild[];
		if ( mode === 'inner' ) {
			newChildren = newVdoms;
		} else if ( mode === 'append' ) {
			newChildren = [ ...oldChildren, ...newVdoms ];
		} else {
			newChildren = [ ...newVdoms, ...oldChildren ];
		}
		startIdx = path.length - 2;
		current = h( target.type, {
			...target.props,
			key: target.key,
			children: newChildren,
		} );
		chainElement = current;
	} else {
		// before / after / replace: splice into the container's parent's
		// children, next to the container's rendered chain root. Climb past
		// component wrappers (Directives/Provider) — a directive-wrapped
		// element is rendered alone by its chain, so its siblings live at the
		// chain root's position.
		let i = path.length - 1;
		while ( i > 0 && typeof path[ i - 1 ].type === 'function' ) {
			i -= 1;
		}
		const anchor = path[ i ];
		const parent = path[ i - 1 ];
		if ( ! parent || typeof parent.type !== 'string' ) {
			// The container is the tree root: only `replace` is supported.
			if ( mode === 'replace' ) {
				const newRoot =
					newVdoms.length === 1
						? newVdoms[ 0 ]
						: h( Fragment, null, newVdoms );
				// Replacing the island root with content that has no island
				// would ORPHAN the fragment — subsequent renderHTML calls
				// could not find an island for the container. Warn and leave
				// the tree untouched.
				const keepsIsland = newVdoms.some(
					( v ) =>
						typeof v === 'object' &&
						v !== null &&
						( v as any ).props?.[ islandAttribute ] !== undefined
				);
				if ( ! keepsIsland ) {
					warn(
						'renderHTML(): replacing the island root with content that has no data-wp-interactive attribute would orphan the tree. The content was not rendered.'
					);
					return;
				}
				render( newRoot as VNode, fragment as ContainerNode );
				return;
			}
			warn( 'renderHTML(): cannot insert before/after the island root.' );
			return;
		}

		const parentChildren = vdomChildren( parent );
		const idx = parentChildren.indexOf( anchor );
		if ( idx === -1 ) {
			warn(
				'renderHTML(): could not locate the container among its siblings.'
			);
			return;
		}
		let newChildren: ComponentChild[];
		if ( mode === 'before' ) {
			newChildren = [
				...parentChildren.slice( 0, idx ),
				...newVdoms,
				...parentChildren.slice( idx ),
			];
		} else if ( mode === 'after' ) {
			newChildren = [
				...parentChildren.slice( 0, idx + 1 ),
				...newVdoms,
				...parentChildren.slice( idx + 1 ),
			];
		} else {
			// replace: replace the anchor.
			newChildren = [
				...parentChildren.slice( 0, idx ),
				...newVdoms,
				...parentChildren.slice( idx + 1 ),
			];
		}
		startIdx = i - 2;
		current = h( parent.type, {
			...parent.props,
			key: parent.key,
			children: newChildren,
		} );
		chainElement = current;
	}

	// Rebuild the path from the insertion point up to the root. When the
	// rebuild passes a region's `router-region` Directives level, mirror the
	// rebuilt region content into the signal BEFORE the render — otherwise
	// the wrapper's re-render re-reads the stale signal and reverts the
	// splice.
	for ( let i = startIdx; i >= 0; i-- ) {
		if (
			path[ i ].type === Directives &&
			path[ i ].props?.priorityLevels?.[ 0 ]?.includes( 'router-region' )
		) {
			writeRegionSignal( path[ i ], current );
		}
		current = rebuildPathNode(
			path[ i ],
			current,
			path[ i + 1 ],
			chainElement
		);
		if ( typeof path[ i ].type === 'string' ) {
			chainElement = current;
		}
	}
	render( current, fragment as ContainerNode );
};

/**
 * Renders an HTML string into the live DOM, processing all Interactivity API
 * directives on it. The markup is commonly server-rendered — e.g. a fragment
 * fetched from a REST endpoint.
 *
 * The HTML is parsed DETACHED and spliced into the container's island tree,
 * so Preact creates the elements itself: the tree stays the single source of
 * truth, component state is preserved across re-renders, and content removed
 * by a later `inner`/`replace` swap unmounts cleanly (listeners cleaned up).
 *
 * ```js
 * import { renderHTML } from '@wordpress/interactivity';
 *
 * const res = await fetch( '/wp-json/my-plugin/v1/cards' );
 * renderHTML( '#feed', await res.text() );
 * ```
 *
 * The container can be an element or a CSS selector (no match → throw) and
 * must be inside an island (`[data-wp-interactive]`) or carry its own
 * `data-wp-interactive`; otherwise nothing is hydrated and a warning is
 * emitted. Router regions ARE supported — the region signal is written
 * through from the spliced tree. Unsupported (warn + no-op):
 * `data-wp-each-child` content and `<template>` elements.
 *
 * List identity: items are matched by key — a user `data-wp-key` wins, then
 * the element's `id`, and (for `prepend`/`before`/`after` only) an
 * auto-generated key as a last resort, so inserting new content never
 * disrupts existing items. `append` is safe with no keys at all.
 * `inner`/`replace` reuse existing elements by position, so same-shape
 * content keeps its state; give items `data-wp-key` (or rely on `id`) when
 * you need identity across refreshes, reorders, or duplicate deliveries.
 *
 * @param container    The element the parsed HTML is inserted into, or a CSS
 *                     selector for it (resolved via `document.querySelector`).
 * @param html         The HTML string.
 * @param options      Options.
 * @param options.mode Where to insert the parsed elements:
 *                     - `append`: as the container's last children (default)
 *                     - `prepend`: as the container's first children
 *                     - `before`: as siblings immediately before the container
 *                     - `after`: as siblings immediately after the container
 *                     - `inner`: replace the container's children
 *                     - `replace`: replace the container itself
 */
export function renderHTML(
	container: Element | string,
	html: string,
	{
		mode = 'append',
	}: {
		mode?: Mode;
	} = {}
): void {
	// Resolve a CSS selector to its element, if one was passed.
	const containerElement =
		typeof container === 'string'
			? document.querySelector( container )
			: container;
	if ( ! containerElement ) {
		throw new Error(
			`renderHTML(): no element found for selector "${ container }".`
		);
	}

	// Use a `<template>` to parse the HTML into nodes (same as the browser
	// would) without triggering side effects like image loading. Use
	// `childNodes` (not `children`) so text nodes in mixed content are
	// preserved instead of silently dropped.
	const template = document.createElement( 'template' );
	template.innerHTML = html;
	const nodes = Array.from( template.content.childNodes ) as Array<
		Element | Text
	>;
	if ( ! nodes.length ) {
		return;
	}

	const island = getTreeIsland( containerElement );
	if ( ! island ) {
		// No island around the container. If the HTML itself carries
		// interactive islands, adopt them: place the parsed nodes per `mode`
		// (raw DOM — no tree yet) and hydrate each outermost island via the
		// sanctioned first-render path (same as `hydrateRegions`). Islands
		// may sit at the top level or inside plain wrappers; nested islands
		// belong to their outer island's tree. Otherwise warn + no-op.
		const htmlIslands = nodes.flatMap( ( node ) => {
			if ( ! ( node instanceof Element ) ) {
				return [];
			}
			if ( node.hasAttribute( islandAttribute ) ) {
				return [ node ];
			}
			return Array.from( node.querySelectorAll( islandSelector ) ).filter(
				( element ) =>
					! element.parentElement?.closest( islandSelector )
			);
		} );
		if ( ! htmlIslands.length ) {
			warn(
				'renderHTML(): no interactive island found for the container. The container must be inside a [data-wp-interactive] subtree or have its own data-wp-interactive attribute.'
			);
			return;
		}
		// The mode name IS the native DOM insertion method, except `inner`
		// (`replaceChildren`) and `replace` (`replaceWith`).
		const placementMethod: Record<
			Mode,
			| 'append'
			| 'prepend'
			| 'before'
			| 'after'
			| 'replaceWith'
			| 'replaceChildren'
		> = {
			append: 'append',
			prepend: 'prepend',
			before: 'before',
			after: 'after',
			inner: 'replaceChildren',
			replace: 'replaceWith',
		};
		containerElement[ placementMethod[ mode ] ]( ...nodes );
		for ( const htmlIsland of htmlIslands ) {
			hydrate(
				toVdom( htmlIsland ) as VNode,
				getRegionRootFragment( [ htmlIsland ] ) as ContainerNode
			);
		}
		return;
	}

	// Build the vdom DETACHED, inheriting the NEAREST island's namespace so
	// directives on the new content resolve against the right store (a
	// container inside a nested island resolves the nested namespace, even
	// though the content is spliced into the OUTER island's tree).
	const namespaceIsland = containerElement.closest( islandSelector )!;
	const namespace = getIslandNamespace( namespaceIsland );
	const vdoms = nodes.map( ( node ) => toVdom( node, namespace ) );

	spliceIntoTree( island, containerElement, mode, vdoms );
}
