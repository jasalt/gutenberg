import { hydrate, type ContainerNode, type ComponentChild } from 'preact';
import { toVdom } from './vdom';
import { createRootFragment, splitTask } from './utils';

// Keep the same root fragment for each interactive region node.
const regionRootFragments = new WeakMap();
export const getRegionRootFragment = (
	regions: Element | Element[]
): ContainerNode => {
	const region = Array.isArray( regions ) ? regions[ 0 ] : regions;
	if ( ! region.parentElement ) {
		throw Error( 'The passed region should be an element with a parent.' );
	}
	if ( ! regionRootFragments.has( region ) ) {
		regionRootFragments.set(
			region,
			createRootFragment( region.parentElement, regions )
		);
	}
	return regionRootFragments.get( region );
};

// Initial vDOM regions associated with its DOM element.
export const initialVdom = new WeakMap< Element, ComponentChild >();

// Promise that resolves with the populated initialVdom after hydration completes.
let resolveInitialVdom!: ( map: WeakMap< Element, ComponentChild > ) => void;
export const initialVdomPromise = new Promise<
	WeakMap< Element, ComponentChild >
>( ( resolve ) => {
	resolveInitialVdom = resolve;
} );

// Top-level islands that were already hydrated, either by `hydrateRegions` or
// on demand (e.g. `renderHTML` targeting an island before `hydrateRegions`
// reached it).
const hydratedRegions = new WeakSet< Element >();

/**
 * Hydrates a top-level interactive island unless it was already hydrated, and
 * records its initial vDOM for the router.
 *
 * @param node The island element.
 * @param vdom The island's vDOM, if already computed.
 * @return Whether the island was hydrated by this call.
 */
export const hydrateRegion = (
	node: Element,
	vdom?: ComponentChild
): boolean => {
	if ( hydratedRegions.has( node ) ) {
		return false;
	}
	hydratedRegions.add( node );
	const fragment = getRegionRootFragment( node );
	const regionVdom = vdom ?? toVdom( node );
	initialVdom.set( node, regionVdom );
	hydrate( regionVdom, fragment );
	return true;
};

/**
 * Hydrates the document's top-level interactive islands and initializes the
 * router's initial vDOM. Islands without an interactive ancestor are selected
 * before any hydration can change the document. Nested islands run only as part
 * of their outer island's tree.
 *
 * @return A promise that resolves once all eligible islands are hydrated.
 */
export const hydrateRegions = async () => {
	const nodes = [
		...document.querySelectorAll( `[data-wp-interactive]` ),
	].filter(
		( node ) => ! node.parentElement?.closest( '[data-wp-interactive]' )
	);

	for ( const node of nodes ) {
		await splitTask();
		if ( hydratedRegions.has( node ) ) {
			continue;
		}
		const vdom = toVdom( node );
		await splitTask();
		// No-op if the island was hydrated on demand during the yield.
		hydrateRegion( node, vdom );
	}

	// Resolve the promise with the fully populated initialVdom after all regions are hydrated.
	resolveInitialVdom( initialVdom );
};
