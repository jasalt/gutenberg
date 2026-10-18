import { createElement } from 'preact';
import { useContext, useMemo, useRef } from 'preact/hooks';
import { directive, isDefaultDirectiveSuffix } from '../hooks';
import { warn, isPlainObject, deepClone } from '../utils';
import { proxifyState, proxifyContext, deepMerge } from '../proxies';

// data-wp-context---[unique-id] — Local state scoping with DOM inheritance.
directive(
	'context',
	( {
		directives: { context },
		props: { children },
		context: inheritedContext,
	} ) => {
		const entries = useMemo(
			() =>
				context
					.filter( isDefaultDirectiveSuffix )
					// Reverses entries to make the ones with unique IDs override the default one.
					.reverse(),
			[ context ]
		);

		// Doesn't do anything if there are no default entries.
		if ( ! entries.length ) {
			if ( globalThis.SCRIPT_DEBUG ) {
				warn(
					'The usage of data-wp-context--unique-id (two hyphens) is not supported. To add a unique ID to the directive, please use data-wp-context---unique-id (three hyphens) instead.'
				);
			}
			return;
		}

		const { Provider } = inheritedContext;
		const { client: inheritedClient, server: inheritedServer } =
			useContext( inheritedContext );
		const client = useRef( {} );

		// Rebuilds the Provider value only when its inputs change. A new object
		// on every render makes the Provider re-render every context consumer
		// below it (each `Directives` component of the subtree), even when
		// nothing changed, e.g. when an ancestor re-renders for `renderHTML`.
		const result = useMemo( () => {
			const server = {};
			const contextValue = {
				client: { ...inheritedClient },
				server: { ...inheritedServer },
			};
			const namespaces = new Set< string >();

			entries.forEach( ( { value, namespace, uniqueId } ) => {
				// Checks that the value is a JSON object. Sends a console warning if not.
				if ( ! isPlainObject( value ) ) {
					if ( globalThis.SCRIPT_DEBUG ) {
						warn(
							`The value of data-wp-context${
								uniqueId ? `---${ uniqueId }` : ''
							} on the ${ namespace } namespace must be a valid stringified JSON object.`
						);
					}
					return;
				}

				// If the namespace doesn't exist yet, initializes an empty
				// proxified state for that namespace's client context.
				if ( ! client.current[ namespace ] ) {
					client.current[ namespace ] = proxifyState( namespace, {} );
				}

				// Merges the new client value with whatever was there before.
				deepMerge(
					client.current[ namespace ],
					deepClone( value ),
					false
				);

				// Replaces the server context for that namespace with the
				// current value.
				server[ namespace ] = value;

				// Registers the namespace.
				namespaces.add( namespace );
			} );

			namespaces.forEach( ( namespace ) => {
				contextValue.client[ namespace ] = proxifyContext(
					client.current[ namespace ],
					inheritedClient[ namespace ]
				);
				contextValue.server[ namespace ] = proxifyContext(
					server[ namespace ],
					inheritedServer[ namespace ]
				);
			} );

			return contextValue;
		}, [ entries, inheritedClient, inheritedServer ] );

		return createElement( Provider, { value: result }, children );
	},
	{ priority: 5 }
);
