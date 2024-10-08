/* eslint-disable valid-jsdoc, @typescript-eslint/no-unused-vars */
import type { ComponentType } from 'react'
import { React } from '../utils/react'
import { isValidElementType, isContextConsumer } from '../utils/react-is'

import type { Store } from 'redux'

import type {
  ConnectedComponent,
  InferableComponentEnhancer,
  InferableComponentEnhancerWithProps,
  ResolveThunks,
  DispatchProp,
  ConnectPropsMaybeWithoutContext,
} from '../types'

import type {
  MapStateToPropsParam,
  MapDispatchToPropsParam,
  MergeProps,
  MapDispatchToPropsNonObject,
  SelectorFactoryOptions,
} from '../connect/selectorFactory'
import defaultSelectorFactory from '../connect/selectorFactory'
import { mapDispatchToPropsFactory } from '../connect/mapDispatchToProps'
import { mapStateToPropsFactory } from '../connect/mapStateToProps'
import { mergePropsFactory } from '../connect/mergeProps'

import type { Subscription } from '../utils/Subscription'
import { createSubscription } from '../utils/Subscription'
import { useIsomorphicLayoutEffect } from '../utils/useIsomorphicLayoutEffect'
import shallowEqual from '../utils/shallowEqual'
import hoistStatics from '../utils/hoistStatics'
import warning from '../utils/warning'

import type {
  ReactReduxContextValue,
  ReactReduxContextInstance,
} from './Context'
import { ReactReduxContext } from './Context'

import type { uSES } from '../utils/useSyncExternalStore'
import { notInitialized } from '../utils/useSyncExternalStore'

let useSyncExternalStore = notInitialized as uSES
export const initializeConnect = (fn: uSES) => {
  useSyncExternalStore = fn
}

// Define some constant arrays just to avoid re-creating these
const EMPTY_ARRAY: [unknown, number] = [null, 0]
const NO_SUBSCRIPTION_ARRAY = [null, null]

// Attempts to stringify whatever not-really-a-component value we were given
// for logging in an error message
const stringifyComponent = (Comp: unknown) => {
  try {
    return JSON.stringify(Comp)
  } catch (err) {
    return String(Comp)
  }
}

type EffectFunc = (...args: any[]) => void | ReturnType<React.EffectCallback>

// This is "just" a `useLayoutEffect`, but with two modifications:
// - we need to fall back to `useEffect` in SSR to avoid annoying warnings
// - we extract this to a separate function to avoid closing over values
//   and causing memory leaks
function useIsomorphicLayoutEffectWithArgs(
  effectFunc: EffectFunc,
  effectArgs: any[],
  dependencies?: React.DependencyList,
) {
  useIsomorphicLayoutEffect(() => effectFunc(...effectArgs), dependencies)
}

// Effect callback, extracted: assign the latest props values to refs for later usage
function captureWrapperProps(
  lastWrapperProps: React.MutableRefObject<unknown>,
  lastChildProps: React.MutableRefObject<unknown>,
  renderIsScheduled: React.MutableRefObject<boolean>,
  wrapperProps: unknown,
  // actualChildProps: unknown,
  childPropsFromStoreUpdate: React.MutableRefObject<unknown>,
  notifyNestedSubs: () => void,
) {
  // We want to capture the wrapper props and child props we used for later comparisons
  lastWrapperProps.current = wrapperProps
  renderIsScheduled.current = false

  // If the render was from a store update, clear out that reference and cascade the subscriber update
  if (childPropsFromStoreUpdate.current) {
    childPropsFromStoreUpdate.current = null
    notifyNestedSubs()
  }
}

// Effect callback, extracted: subscribe to the Redux store or nearest connected ancestor,
// check for updates after dispatched actions, and trigger re-renders.
function subscribeUpdates(
  shouldHandleStateChanges: boolean,
  store: Store,
  subscription: Subscription,
  childPropsSelector: (state: unknown, props: unknown) => unknown,
  lastWrapperProps: React.MutableRefObject<unknown>,
  lastChildProps: React.MutableRefObject<unknown>,
  renderIsScheduled: React.MutableRefObject<boolean>,
  isMounted: React.MutableRefObject<boolean>,
  childPropsFromStoreUpdate: React.MutableRefObject<unknown>,
  notifyNestedSubs: () => void,
  // forceComponentUpdateDispatch: React.Dispatch<any>,
  additionalSubscribeListener: () => void,
) {
  // If we're not subscribed to the store, nothing to do here

  // 如果没有订阅store, 直接返回
  if (!shouldHandleStateChanges) return () => {}

  // Capture values for checking if and when this component unmounts
  let didUnsubscribe = false
  let lastThrownError: Error | null = null

  // We'll run this callback every time a store subscription update propagates to this component

  // 每次当前组件关联的state更新时, 都会执行这个回调函数
  const checkForUpdates = () => {
    if (didUnsubscribe || !isMounted.current) {
      // Don't run stale listeners.
      // Redux doesn't guarantee unsubscriptions happen until next dispatch.
      return
    }

    // TODO We're currently calling getState ourselves here, rather than letting `uSES` do it
    const latestStoreState = store.getState()

    let newChildProps, error
    try {
      // Actually run the selector with the most recent store state and wrapper props
      // to determine what the child props should be
      // 用 state 和 props 计算最新的childProps
      newChildProps = childPropsSelector(
        latestStoreState,
        lastWrapperProps.current,
      )
    } catch (e) {
      error = e
      lastThrownError = e as Error | null
    }

    if (!error) {
      lastThrownError = null
    }

    // If the child props haven't changed, nothing to do here - cascade the subscription update
    // 如果childProps没有变化, 那么直接通知下一层组件发起更新即可
    if (newChildProps === lastChildProps.current) {
      if (!renderIsScheduled.current) {
        notifyNestedSubs()
      }
    } else {
      // Save references to the new child props.  Note that we track the "child props from store update"
      // as a ref instead of a useState/useReducer because we need a way to determine if that value has
      // been processed.  If this went into useState/useReducer, we couldn't clear out the value without
      // forcing another re-render, which we don't want.

      // 保存最新一次的计算结果
      lastChildProps.current = newChildProps
      childPropsFromStoreUpdate.current = newChildProps
      // 标记组件组件有计划进行一次渲染了
      renderIsScheduled.current = true

      // TODO This is hacky and not how `uSES` is meant to be used
      // Trigger the React `useSyncExternalStore` subscriber
      // 调用 React 传入的 reactLisenser 函数，随后便会触发组件的重新渲染
      additionalSubscribeListener()

      // 看到这里会发现，还没调用 notifyNestedSubs 以触发其子组件的订阅
    }
  }

  // Actually subscribe to the nearest connected ancestor (or store)
  // 将订阅更新函数绑定到了其上一层 connect 组件的subscription上（默认情况下）
  subscription.onStateChange = checkForUpdates
  subscription.trySubscribe()

  // Pull data from the store after first render in case the store has
  // changed since we began.
  // 第一次运行时就调用一遍 checkForUpdates 函数
  checkForUpdates()

  // useSyncExternalStore 需要的卸载函数
  const unsubscribeWrapper = () => {
    didUnsubscribe = true
    subscription.tryUnsubscribe()
    subscription.onStateChange = null

    if (lastThrownError) {
      // It's possible that we caught an error due to a bad mapState function, but the
      // parent re-rendered without this component and we're about to unmount.
      // This shouldn't happen as long as we do top-down subscriptions correctly, but
      // if we ever do those wrong, this throw will surface the error in our tests.
      // In that case, throw the error from here so it doesn't get lost.
      throw lastThrownError
    }
  }

  return unsubscribeWrapper
}

// Reducer initial state creation for our update reducer
const initStateUpdates = () => EMPTY_ARRAY

export interface ConnectProps {
  /** A custom Context instance that the component can use to access the store from an alternate Provider using that same Context instance */
  context?: ReactReduxContextInstance
  /** A Redux store instance to be used for subscriptions instead of the store from a Provider */
  store?: Store
}

interface InternalConnectProps extends ConnectProps {
  reactReduxForwardedRef?: React.ForwardedRef<unknown>
}

function strictEqual(a: unknown, b: unknown) {
  return a === b
}

/**
 * Infers the type of props that a connector will inject into a component.
 */
export type ConnectedProps<TConnector> =
  TConnector extends InferableComponentEnhancerWithProps<
    infer TInjectedProps,
    any
  >
    ? unknown extends TInjectedProps
      ? TConnector extends InferableComponentEnhancer<infer TInjectedProps>
        ? TInjectedProps
        : never
      : TInjectedProps
    : never

export interface ConnectOptions<
  State = unknown,
  TStateProps = {},
  TOwnProps = {},
  TMergedProps = {},
> {
  forwardRef?: boolean
  context?: typeof ReactReduxContext
  areStatesEqual?: (
    nextState: State,
    prevState: State,
    nextOwnProps: TOwnProps,
    prevOwnProps: TOwnProps,
  ) => boolean

  areOwnPropsEqual?: (
    nextOwnProps: TOwnProps,
    prevOwnProps: TOwnProps,
  ) => boolean

  areStatePropsEqual?: (
    nextStateProps: TStateProps,
    prevStateProps: TStateProps,
  ) => boolean
  areMergedPropsEqual?: (
    nextMergedProps: TMergedProps,
    prevMergedProps: TMergedProps,
  ) => boolean
}

/**
 * Connects a React component to a Redux store.
 *
 * - Without arguments, just wraps the component, without changing the behavior / props
 *
 * - If 2 params are passed (3rd param, mergeProps, is skipped), default behavior
 * is to override ownProps (as stated in the docs), so what remains is everything that's
 * not a state or dispatch prop
 *
 * - When 3rd param is passed, we don't know if ownProps propagate and whether they
 * should be valid component props, because it depends on mergeProps implementation.
 * As such, it is the user's responsibility to extend ownProps interface from state or
 * dispatch props or both when applicable
 *
 * @param mapStateToProps
 * @param mapDispatchToProps
 * @param mergeProps
 * @param options
 */
export interface Connect<DefaultState = unknown> {
  // tslint:disable:no-unnecessary-generics
  (): InferableComponentEnhancer<DispatchProp>

  /** mapState only */
  <TStateProps = {}, no_dispatch = {}, TOwnProps = {}, State = DefaultState>(
    mapStateToProps: MapStateToPropsParam<TStateProps, TOwnProps, State>,
  ): InferableComponentEnhancerWithProps<TStateProps & DispatchProp, TOwnProps>

  /** mapDispatch only (as a function) */
  <no_state = {}, TDispatchProps = {}, TOwnProps = {}>(
    mapStateToProps: null | undefined,
    mapDispatchToProps: MapDispatchToPropsNonObject<TDispatchProps, TOwnProps>,
  ): InferableComponentEnhancerWithProps<TDispatchProps, TOwnProps>

  /** mapDispatch only (as an object) */
  <no_state = {}, TDispatchProps = {}, TOwnProps = {}>(
    mapStateToProps: null | undefined,
    mapDispatchToProps: MapDispatchToPropsParam<TDispatchProps, TOwnProps>,
  ): InferableComponentEnhancerWithProps<
    ResolveThunks<TDispatchProps>,
    TOwnProps
  >

  /** mapState and mapDispatch (as a function)*/
  <TStateProps = {}, TDispatchProps = {}, TOwnProps = {}, State = DefaultState>(
    mapStateToProps: MapStateToPropsParam<TStateProps, TOwnProps, State>,
    mapDispatchToProps: MapDispatchToPropsNonObject<TDispatchProps, TOwnProps>,
  ): InferableComponentEnhancerWithProps<
    TStateProps & TDispatchProps,
    TOwnProps
  >

  /** mapState and mapDispatch (nullish) */
  <TStateProps = {}, TDispatchProps = {}, TOwnProps = {}, State = DefaultState>(
    mapStateToProps: MapStateToPropsParam<TStateProps, TOwnProps, State>,
    mapDispatchToProps: null | undefined,
  ): InferableComponentEnhancerWithProps<TStateProps, TOwnProps>

  /** mapState and mapDispatch (as an object) */
  <TStateProps = {}, TDispatchProps = {}, TOwnProps = {}, State = DefaultState>(
    mapStateToProps: MapStateToPropsParam<TStateProps, TOwnProps, State>,
    mapDispatchToProps: MapDispatchToPropsParam<TDispatchProps, TOwnProps>,
  ): InferableComponentEnhancerWithProps<
    TStateProps & ResolveThunks<TDispatchProps>,
    TOwnProps
  >

  /** mergeProps only */
  <no_state = {}, no_dispatch = {}, TOwnProps = {}, TMergedProps = {}>(
    mapStateToProps: null | undefined,
    mapDispatchToProps: null | undefined,
    mergeProps: MergeProps<undefined, DispatchProp, TOwnProps, TMergedProps>,
  ): InferableComponentEnhancerWithProps<TMergedProps, TOwnProps>

  /** mapState and mergeProps */
  <
    TStateProps = {},
    no_dispatch = {},
    TOwnProps = {},
    TMergedProps = {},
    State = DefaultState,
  >(
    mapStateToProps: MapStateToPropsParam<TStateProps, TOwnProps, State>,
    mapDispatchToProps: null | undefined,
    mergeProps: MergeProps<TStateProps, DispatchProp, TOwnProps, TMergedProps>,
  ): InferableComponentEnhancerWithProps<TMergedProps, TOwnProps>

  /** mapDispatch (as a object) and mergeProps */
  <no_state = {}, TDispatchProps = {}, TOwnProps = {}, TMergedProps = {}>(
    mapStateToProps: null | undefined,
    mapDispatchToProps: MapDispatchToPropsParam<TDispatchProps, TOwnProps>,
    mergeProps: MergeProps<undefined, TDispatchProps, TOwnProps, TMergedProps>,
  ): InferableComponentEnhancerWithProps<TMergedProps, TOwnProps>

  /** mapState and options */
  <TStateProps = {}, no_dispatch = {}, TOwnProps = {}, State = DefaultState>(
    mapStateToProps: MapStateToPropsParam<TStateProps, TOwnProps, State>,
    mapDispatchToProps: null | undefined,
    mergeProps: null | undefined,
    options: ConnectOptions<State, TStateProps, TOwnProps>,
  ): InferableComponentEnhancerWithProps<DispatchProp & TStateProps, TOwnProps>

  /** mapDispatch (as a function) and options */
  <TStateProps = {}, TDispatchProps = {}, TOwnProps = {}>(
    mapStateToProps: null | undefined,
    mapDispatchToProps: MapDispatchToPropsNonObject<TDispatchProps, TOwnProps>,
    mergeProps: null | undefined,
    options: ConnectOptions<{}, TStateProps, TOwnProps>,
  ): InferableComponentEnhancerWithProps<TDispatchProps, TOwnProps>

  /** mapDispatch (as an object) and options*/
  <TStateProps = {}, TDispatchProps = {}, TOwnProps = {}>(
    mapStateToProps: null | undefined,
    mapDispatchToProps: MapDispatchToPropsParam<TDispatchProps, TOwnProps>,
    mergeProps: null | undefined,
    options: ConnectOptions<{}, TStateProps, TOwnProps>,
  ): InferableComponentEnhancerWithProps<
    ResolveThunks<TDispatchProps>,
    TOwnProps
  >

  /** mapState,  mapDispatch (as a function), and options */
  <TStateProps = {}, TDispatchProps = {}, TOwnProps = {}, State = DefaultState>(
    mapStateToProps: MapStateToPropsParam<TStateProps, TOwnProps, State>,
    mapDispatchToProps: MapDispatchToPropsNonObject<TDispatchProps, TOwnProps>,
    mergeProps: null | undefined,
    options: ConnectOptions<State, TStateProps, TOwnProps>,
  ): InferableComponentEnhancerWithProps<
    TStateProps & TDispatchProps,
    TOwnProps
  >

  /** mapState,  mapDispatch (as an object), and options */
  <TStateProps = {}, TDispatchProps = {}, TOwnProps = {}, State = DefaultState>(
    mapStateToProps: MapStateToPropsParam<TStateProps, TOwnProps, State>,
    mapDispatchToProps: MapDispatchToPropsParam<TDispatchProps, TOwnProps>,
    mergeProps: null | undefined,
    options: ConnectOptions<State, TStateProps, TOwnProps>,
  ): InferableComponentEnhancerWithProps<
    TStateProps & ResolveThunks<TDispatchProps>,
    TOwnProps
  >

  /** mapState, mapDispatch, mergeProps, and options */
  <
    TStateProps = {},
    TDispatchProps = {},
    TOwnProps = {},
    TMergedProps = {},
    State = DefaultState,
  >(
    mapStateToProps: MapStateToPropsParam<TStateProps, TOwnProps, State>,
    mapDispatchToProps: MapDispatchToPropsParam<TDispatchProps, TOwnProps>,
    mergeProps: MergeProps<
      TStateProps,
      TDispatchProps,
      TOwnProps,
      TMergedProps
    >,
    options?: ConnectOptions<State, TStateProps, TOwnProps, TMergedProps>,
  ): InferableComponentEnhancerWithProps<TMergedProps, TOwnProps>
  // tslint:enable:no-unnecessary-generics
}

let hasWarnedAboutDeprecatedPureOption = false

/**
 * Connects a React component to a Redux store.
 *
 * - Without arguments, just wraps the component, without changing the behavior / props
 *
 * - If 2 params are passed (3rd param, mergeProps, is skipped), default behavior
 * is to override ownProps (as stated in the docs), so what remains is everything that's
 * not a state or dispatch prop
 *
 * - When 3rd param is passed, we don't know if ownProps propagate and whether they
 * should be valid component props, because it depends on mergeProps implementation.
 * As such, it is the user's responsibility to extend ownProps interface from state or
 * dispatch props or both when applicable
 *
 * @param mapStateToProps A function that extracts values from state
 * @param mapDispatchToProps Setup for dispatching actions
 * @param mergeProps Optional callback to merge state and dispatch props together
 * @param options Options for configuring the connection
 *
 */
function connect<
  TStateProps = {},
  TDispatchProps = {},
  TOwnProps = {},
  TMergedProps = {},
  State = unknown,
>(
  mapStateToProps?: MapStateToPropsParam<TStateProps, TOwnProps, State>,
  mapDispatchToProps?: MapDispatchToPropsParam<TDispatchProps, TOwnProps>,
  mergeProps?: MergeProps<TStateProps, TDispatchProps, TOwnProps, TMergedProps>,
  {
    // The `pure` option has been removed, so TS doesn't like us destructuring this to check its existence.
    // @ts-ignore
    pure,
    areStatesEqual = strictEqual,
    areOwnPropsEqual = shallowEqual,
    areStatePropsEqual = shallowEqual,
    areMergedPropsEqual = shallowEqual,

    // use React's forwardRef to expose a ref of the wrapped component
    forwardRef = false,

    // the context consumer to use
    context = ReactReduxContext,
  }: ConnectOptions<unknown, unknown, unknown, unknown> = {},
): unknown {
  if (process.env.NODE_ENV !== 'production') {
    if (pure !== undefined && !hasWarnedAboutDeprecatedPureOption) {
      hasWarnedAboutDeprecatedPureOption = true
      warning(
        'The `pure` option has been removed. `connect` is now always a "pure/memoized" component',
      )
    }
  }

  const Context = context
  // 通过工厂函数，对传入的函数做格式校验、默认值处理，并返回一个区分第一次执行和 N 次执行逻辑的新函数
  const initMapStateToProps = mapStateToPropsFactory(mapStateToProps)
  const initMapDispatchToProps = mapDispatchToPropsFactory(mapDispatchToProps)
  const initMergeProps = mergePropsFactory(mergeProps)

  // 判断是否应该处理 state 变化
  const shouldHandleStateChanges = Boolean(mapStateToProps)

  // wrapWithConnect 就是执行 connect(mapStateToProps,mapDispatchToProps) 后的返回值
  // 一个 HOC：接收一个组件作为参数，返回增强后的组件
  const wrapWithConnect = <TProps,>(
    WrappedComponent: ComponentType<TProps>,
  ) => {
    type WrappedComponentProps = TProps &
      ConnectPropsMaybeWithoutContext<TProps>

    if (process.env.NODE_ENV !== 'production') {
      const isValid = /*#__PURE__*/ isValidElementType(WrappedComponent)
      if (!isValid)
        throw new Error(
          `You must pass a component to the function returned by connect. Instead received ${stringifyComponent(
            WrappedComponent,
          )}`,
        )
    }

    const wrappedComponentName =
      WrappedComponent.displayName || WrappedComponent.name || 'Component'

    const displayName = `Connect(${wrappedComponentName})`

    const selectorFactoryOptions: SelectorFactoryOptions<
      any,
      any,
      any,
      any,
      State
    > = {
      shouldHandleStateChanges,
      displayName,
      wrappedComponentName,
      WrappedComponent,
      // @ts-ignore
      initMapStateToProps,
      initMapDispatchToProps,
      initMergeProps,
      areStatesEqual,
      areStatePropsEqual,
      areOwnPropsEqual,
      areMergedPropsEqual,
    }

    // ConnectFuction 可以看作是 HOC 的直接返回值，与 Redux 相关的状态更新逻辑都封装在其中
    function ConnectFunction<TOwnProps>(
      props: InternalConnectProps & TOwnProps,
    ) {
      // 这里是从 props 中提取出 reactReduxForwardedRef 和其他的 wrapperProps，
      // 同时将 props.context 作为一个单独的变量返回。
      // 这样做的目的是为了区分传递给包装组件的实际“数据”属性和控制行为所需的值（如转发的引用、替代上下文实例）。
      const [propsContext, reactReduxForwardedRef, wrapperProps] =
        React.useMemo(() => {
          // Distinguish between actual "data" props that were passed to the wrapper component,
          // and values needed to control behavior (forwarded refs, alternate context instances).
          // To maintain the wrapperProps object reference, memoize this destructuring.
          const { reactReduxForwardedRef, ...wrapperProps } = props
          return [props.context, reactReduxForwardedRef, wrapperProps]
        }, [props])
      // 决定 connect 函数应该使用哪个 React Context 实例来订阅 Redux store 的变化
      // 1. 如果用户通过 props.context 传递了自定义的 React Context 实例，则使用该实例
      // 2. 否则，使用默认的 ReactReduxContext 实例
      const ContextToUse: ReactReduxContextInstance = React.useMemo(() => {
        // Users may optionally pass in a custom context instance to use instead of our ReactReduxContext.
        // Memoize the check that determines which context instance we should use.
        let ResultContext = Context
        if (propsContext?.Consumer) {
          if (process.env.NODE_ENV !== 'production') {
            const isValid = /*#__PURE__*/ isContextConsumer(
              // @ts-ignore
              <propsContext.Consumer />,
            )
            if (!isValid) {
              throw new Error(
                'You must pass a valid React context consumer as `props.context`',
              )
            }
            ResultContext = propsContext
          }
        }
        return ResultContext
      }, [propsContext, Context])

      // Retrieve the store and ancestor subscription via context, if available
      const contextValue = React.useContext(ContextToUse)

      // The store _must_ exist as either a prop or in context.
      // We'll check to see if it _looks_ like a Redux store first.
      // This allows us to pass through a `store` prop that is just a plain value.

      // 判断 store 是从 props 中传递的还是从 context 中传递的。
      // 如果props 中只是个名为 store 的普通对象，那还是会使用 context 中的 store
      const didStoreComeFromProps =
        Boolean(props.store) &&
        Boolean(props.store!.getState) &&
        Boolean(props.store!.dispatch)
      const didStoreComeFromContext =
        Boolean(contextValue) && Boolean(contextValue!.store)

      if (
        process.env.NODE_ENV !== 'production' &&
        !didStoreComeFromProps &&
        !didStoreComeFromContext
      ) {
        throw new Error(
          `Could not find "store" in the context of ` +
            `"${displayName}". Either wrap the root component in a <Provider>, ` +
            `or pass a custom React context provider to <Provider> and the corresponding ` +
            `React context consumer to ${displayName} in connect options.`,
        )
      }

      // Based on the previous check, one of these must be true
      const store: Store = didStoreComeFromProps
        ? props.store!
        : contextValue!.store

      const getServerState = didStoreComeFromContext
        ? contextValue!.getServerState
        : store.getState

      // 通过工厂函数，生成一个处理组件 props 变化的函数：根据最新的state 和 props 计算最终的 props
      // childPropsSelector：(nextState: State, nextOwnProps: any) => any
      const childPropsSelector = React.useMemo(() => {
        // The child props selector needs the store reference as an input.
        // Re-create this selector whenever the store changes.
        return defaultSelectorFactory(store.dispatch, selectorFactoryOptions)
      }, [store])

      // subscription：当前组件的订阅实例
      // notifyNestedSubs: 通知直接后代组件的更新
      // 那么当前组件怎么被他的 parent 更新？
      const [subscription, notifyNestedSubs] = React.useMemo(() => {
        if (!shouldHandleStateChanges) return NO_SUBSCRIPTION_ARRAY

        // This Subscription's source should match where store came from: props vs. context. A component
        // connected to the store via props shouldn't use subscription from context, or vice versa.

        const subscription = createSubscription(
          store,
          didStoreComeFromProps ? undefined : contextValue!.subscription,
        )

        // `notifyNestedSubs` is duplicated to handle the case where the component is unmounted in
        // the middle of the notification loop, where `subscription` will then be null. This can
        // probably be avoided if Subscription's listeners logic is changed to not call listeners
        // that have been unsubscribed in the  middle of the notification loop.
        const notifyNestedSubs =
          subscription.notifyNestedSubs.bind(subscription)

        return [subscription, notifyNestedSubs]
      }, [store, didStoreComeFromProps, contextValue])

      // Determine what {store, subscription} value should be put into nested context, if necessary,
      // and memoize that value to avoid unnecessary context updates.
      // 传递给后续组件的 context 值
      // 1. 如果 store 是从 props 中传递的，则直接使用本组件接收的上层 contextValue
      // 2. 如果 store 是从 context 中传递的，则需要同当前的 subscription 覆盖原始 contextValue 的 subscription
      const overriddenContextValue = React.useMemo(() => {
        if (didStoreComeFromProps) {
          // This component is directly subscribed to a store from props.
          // We don't want descendants reading from this store - pass down whatever
          // the existing context value is from the nearest connected ancestor.
          return contextValue!
        }

        // Otherwise, put this component's subscription instance into context, so that
        // connected descendants won't update until after this component is done
        return {
          ...contextValue,
          subscription,
        } as ReactReduxContextValue
      }, [didStoreComeFromProps, contextValue, subscription])

      // Set up refs to coordinate values between the subscription effect and the render logic
      const lastChildProps = React.useRef<unknown>(undefined)
      const lastWrapperProps = React.useRef(wrapperProps)
      const childPropsFromStoreUpdate = React.useRef<unknown>(undefined)
      // 标记当前组件是否有正在计划的渲染
      const renderIsScheduled = React.useRef(false)
      const isMounted = React.useRef(false)

      // TODO: Change this to `React.useRef<Error>(undefined)` after upgrading to React 19.
      /**
       * @todo Change this to `React.useRef<Error>(undefined)` after upgrading to React 19.
       */
      const latestSubscriptionCallbackError = React.useRef<Error | undefined>(
        undefined,
      )

      // 判断当前组件是否被挂载
      useIsomorphicLayoutEffect(() => {
        isMounted.current = true
        return () => {
          isMounted.current = false
        }
      }, [])

      //返回一个闭包函数，基于最新的 store 状态和 wrapperProps 计算实际业务子组件的 props
      // 1. 上次计算的结果存在，wrapperProps 没有变化，则直接使用上次计算的结果——这种情况也就是由 state 变化造成的重新调用
      // 2. 重新调用 childPropsSelector 计算子组件的 props——这种情况是 wrapperProps 变化造成的
      const actualChildPropsSelector = React.useMemo(() => {
        const selector = () => {
          // Tricky logic here:
          // - This render may have been triggered by a Redux store update that produced new child props
          // - However, we may have gotten new wrapper props after that
          // If we have new child props, and the same wrapper props, we know we should use the new child props as-is.
          // But, if we have new wrapper props, those might change the child props, so we have to recalculate things.
          // So, we'll use the child props from store update only if the wrapper props are the same as last time.
          if (
            childPropsFromStoreUpdate.current &&
            wrapperProps === lastWrapperProps.current
          ) {
            return childPropsFromStoreUpdate.current
          }

          // TODO We're reading the store directly in render() here. Bad idea?
          // This will likely cause Bad Things (TM) to happen in Concurrent Mode.
          // Note that we do this because on renders _not_ caused by store updates, we need the latest store state
          // to determine what the child props should be.
          return childPropsSelector(store.getState(), wrapperProps)
        }
        return selector
      }, [store, wrapperProps])

      // We need this to execute synchronously every time we re-render. However, React warns
      // about useLayoutEffect in SSR, so we try to detect environment and fall back to
      // just useEffect instead to avoid the warning, since neither will run anyway.

      // 一个用于提供给 useSyncExternalStore 的订阅函数
      const subscribeForReact = React.useMemo(() => {
        const subscribe = (reactListener: () => void) => {
          if (!subscription) {
            return () => {}
          }
          // 其中会绑定 reactListener 函数到 subscription 上，是绑定 Redux state 变化 和 React 组件更新的核心逻辑
          return subscribeUpdates(
            shouldHandleStateChanges,
            store,
            subscription,
            // @ts-ignore
            childPropsSelector,
            lastWrapperProps,
            lastChildProps,
            renderIsScheduled,
            isMounted,
            childPropsFromStoreUpdate,
            notifyNestedSubs,
            reactListener,
          )
        }

        return subscribe
      }, [subscription])

      // 这里视作 useEffct，会在每次渲染都执行：
      // 保存最新的 wrapperProps
      // 如果 childPropsFromStoreUpdate 的值不为空，则说明当前组件的渲染是由 store 引起的，然后执行notifyNestedSubs通知直接后代组件更新
      useIsomorphicLayoutEffectWithArgs(captureWrapperProps, [
        lastWrapperProps,
        lastChildProps,
        renderIsScheduled,
        wrapperProps,
        childPropsFromStoreUpdate,
        notifyNestedSubs,
      ])

      let actualChildProps: Record<string, unknown>

      try {
        actualChildProps = useSyncExternalStore(
          // TODO We're passing through a big wrapper that does a bunch of extra side effects besides subscribing
          subscribeForReact,
          // TODO This is incredibly hacky. We've already processed the store update and calculated new child props,
          // TODO and we're just passing that through so it triggers a re-render for us rather than relying on `uSES`.
          actualChildPropsSelector,
          getServerState
            ? () => childPropsSelector(getServerState(), wrapperProps)
            : actualChildPropsSelector,
        )
      } catch (err) {
        if (latestSubscriptionCallbackError.current) {
          // eslint-disable-next-line no-extra-semi
          ;(err as Error).message +=
            `\nThe error may be correlated with this previous error:\n${latestSubscriptionCallbackError.current.stack}\n\n`
        }

        throw err
      }

      // 这里就视作 useLayoutEffect
      // 清空错误信息和上次渲染的子组件 props
      // 保存这次传递给业务子组件的 props
      useIsomorphicLayoutEffect(() => {
        latestSubscriptionCallbackError.current = undefined
        childPropsFromStoreUpdate.current = undefined
        lastChildProps.current = actualChildProps
      })

      // Now that all that's done, we can finally try to actually render the child component.
      // We memoize the elements for the rendered child component as an optimization.
      // 默认都会使用useMemo包裹子组件提高性能
      const renderedWrappedComponent = React.useMemo(() => {
        return (
          // @ts-ignore
          <WrappedComponent
            {...actualChildProps}
            ref={reactReduxForwardedRef}
          />
        )
      }, [reactReduxForwardedRef, WrappedComponent, actualChildProps])

      // If React sees the exact same element reference as last time, it bails out of re-rendering
      // that child, same as if it was wrapped in React.memo() or returned false from shouldComponentUpdate.
      // 如果当前的组件订阅了 state 的状态，那么需要用当前组件的 subscription 覆盖 contextValue 的 subscription，
      // 这样能保证后续组件的更新，能在当前组件响应完 state 变化后再触发
      const renderedChild = React.useMemo(() => {
        if (shouldHandleStateChanges) {
          // If this component is subscribed to store updates, we need to pass its own
          // subscription instance down to our descendants. That means rendering the same
          // Context instance, and putting a different value into the context.
          return (
            <ContextToUse.Provider value={overriddenContextValue}>
              {renderedWrappedComponent}
            </ContextToUse.Provider>
          )
        }

        return renderedWrappedComponent
      }, [ContextToUse, renderedWrappedComponent, overriddenContextValue])

      return renderedChild
    }

    const _Connect = React.memo(ConnectFunction)

    type ConnectedWrapperComponent = typeof _Connect & {
      WrappedComponent: typeof WrappedComponent
    }

    // Add a hacky cast to get the right output type
    const Connect = _Connect as unknown as ConnectedComponent<
      typeof WrappedComponent,
      WrappedComponentProps
    >
    Connect.WrappedComponent = WrappedComponent
    Connect.displayName = ConnectFunction.displayName = displayName
    // 转发 Ref
    if (forwardRef) {
      const _forwarded = React.forwardRef(
        function forwardConnectRef(props, ref) {
          // @ts-ignore
          return <Connect {...props} reactReduxForwardedRef={ref} />
        },
      )

      const forwarded = _forwarded as ConnectedWrapperComponent
      forwarded.displayName = displayName
      forwarded.WrappedComponent = WrappedComponent
      return /*#__PURE__*/ hoistStatics(forwarded, WrappedComponent)
    }

    return /*#__PURE__*/ hoistStatics(Connect, WrappedComponent)
  }

  return wrapWithConnect
}

export default connect as Connect
