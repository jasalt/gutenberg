import { cloneElement, type VNode } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import {
	directive,
	isDefaultDirectiveSuffix,
	type DirectiveEntry,
} from '../hooks';
import { getScope, navigationContextSignal } from '../scopes';
import {
	warnSuffixNotSupported,
	warnUniqueIdNotSupported,
} from './utils/warnings';

/**
 * Relates each router region with its current vDOM content. Used by the
 * `router-region` directive.
 *
 * Keys are router region IDs, and values are signals with the corresponding
 * VNode rendered inside. If the value is `null`, that means the regions should
 * not be rendered. If the value is `undefined`, the region is already contained
 * inside another router region and does not need to change its children.
 */
export const routerRegions = new Map<
	string,
	Signal< VNode | null | undefined >
>();

/**
 * Returns the region ID of a `router-region` directive entry: the value
 * itself when it is a string, or its `id` property.
 *
 * @param entry The directive entry.
 * @return The region ID.
 */
export const getRegionId = ( entry: DirectiveEntry ): string =>
	typeof entry.value === 'string' ? entry.value : ( entry.value as any )?.id;

/**
 * Region contents written into a region signal by `renderHTML` (a splice
 * into a navigated region), as opposed to a navigation. They must not
 * trigger the navigation invalidation below: the server context did not
 * change.
 */
export const splicedRegionContents = new WeakSet< VNode >();

// data-wp-router-region — Router region management.
directive(
	'router-region',
	( { directives: { 'router-region': routerRegion } } ) => {
		const entry = routerRegion.find( isDefaultDirectiveSuffix );
		if ( ! entry ) {
			return;
		}

		if ( entry.suffix ) {
			if ( globalThis.SCRIPT_DEBUG ) {
				warnSuffixNotSupported( 'router-region', entry.suffix );
			}
			return;
		}

		if ( entry.uniqueId ) {
			if ( globalThis.SCRIPT_DEBUG ) {
				warnUniqueIdNotSupported( 'router-region', entry.uniqueId );
			}
			return;
		}

		const regionId = getRegionId( entry );

		if ( ! routerRegions.has( regionId ) ) {
			routerRegions.set( regionId, signal() );
		}

		// Get the content of this router region.
		const vdom = routerRegions.get( regionId )!.value;

		// Triggers an invalidation after the directive data-wp-context has
		// been evaluated and the value of the server context has changed.
		useLayoutEffect( () => {
			if (
				vdom &&
				typeof vdom.type !== 'string' &&
				! splicedRegionContents.has( vdom )
			) {
				navigationContextSignal.value =
					navigationContextSignal.peek() + 1;
			}
		}, [ vdom ] );

		if ( vdom && typeof vdom.type !== 'string' ) {
			// The scope needs to be injected.
			const previousScope = getScope();
			return cloneElement( vdom, { previousScope } );
		}
		return vdom;
	},
	{ priority: 1 }
);
