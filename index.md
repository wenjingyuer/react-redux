## react-redux 设计思想

### react-redux 解决了什么问题

由于 Redux 本身并不和任何前端开发框架绑定，因此要在 React 中直接使用 Redux 的成本还是较高，主要体现在两个方面：一是需要很多“模板代码”才能将 Redux 状态变化和 React 视图更新绑定，二是需要控制 Redux 状态更新时 React 组件的更新顺序（React 的数据流是父->子，如果一个公用变量变化了，是父组件先更新，然后参数传给子组件）和组件渲染性能。

参见：[why-use-react-redux](https://cn.react-redux.js.org/introduction/why-use-react-redux)。

## 基本概念

### Provider

<Provider> 以 React context 的方式将 Redux store 传递给任何需要的组件。

```TSX
const store = createStore()

// 从 React 18 起
const root = ReactDOM.createRoot(document.getElementById('root'))
root.render(
  <Provider store={store}>
    <App />
  </Provider>
)

```

### connect()

connect() 函数将 React 组件连接到 React store———将 Redux 的 state、dispach 通过 props 的形式传递给 React 组件，并视情况控制组件的更新。

> 在 React 函数式组件开发中，官方推荐使用 Hooks 代替 connect() 的使用

connect() 用法实例：

```TSX
export default connect(mapStateToProps?, mapDispatchToProps?, mergeProps?, options?)(TodoApp)
```

### Hooks

**useSelector()**

useSelector 可以理解为是 connect 中 mapStateToProps 函数的"平替"，用于获取并响应**特定** state 变量的变化。用法：

```TSX
const result: any = useSelector(selector: Function, equalityFn?: Function)
// 🌰
export const CounterComponent = () => {
  const counter = useSelector((state) => state.counter)
  return <div>{counter}</div>
}
```

**useDispatch()**

useSelector 可以理解为是 connect 中 mapDispatchToProps 的"平替"，用于获取和 store 绑定的 dispach 函数。用法：

```TSX
const dispatch = useDispatch()
```

**useStore()**

返回一个 Redux store 引用，该 store 与传递给 <Provider> 组件的 store 相同。

```TSX
const store = useStore()
```

## 源码解析

react-redux 的核心原理并不复杂，但是代码实现中考虑了很多组件渲染顺序控制以及性能优化逻辑，因此会显得较难理解，下面尝试以“手写RR”的方式对源码进行解析，从核心逻辑开始还原 react-redux 的设计思想。

### Provider

一个简版的 Provider 设计如下，其本质上是以 Context 的形式传递 Redux 的 store 实例，同时也支持用户传入自己的 Context。

```TSX
import { ReactReduxContext } from './Context'

function Provider<A extends Action<string> = UnknownAction, S = unknown>({
  store,
  context,
  children,
}: ProviderProps<A, S>) {
  const contextValue = React.useMemo(() => {
    return {
      store,
    }
  }, [store, ])

  const Context = context || ReactReduxContext

  return <Context.Provider value={contextValue}>{children}</Context.Provider>
}

export default Provider
```

### connet()

connet()函数执行后，将返回一个 HOC，用于将 React 组件连接到 Redux store。根据接收函数的不同，返回的 HOC 将具有不同的特性：

- 不传参数时,只是简单包装组件,不改变其行为或 props。
- 如果传入 2 个参数(跳过第 3 个参数 mergeProps),默认行为是覆盖 ownProps(使用 Object.asign)的内容。
- 当传入第 3 个参数时,react-redux 将不知道 ownProps 是否会传递,以及它们是否应该是有效的组件 props,因为这取决于 mergeProps 的实现，此时交由用户控制最终传递给组件的 Props。

**基本功能**

下面代码中还原了connet()最基本的能力：执行 mapStateToProps、mapDispatchToProps，并将返回值和接收的 props 合并后再传递给 React 组件。

```TSX
import React, { useContext } from 'react';
import ReactReduxContext from './Context';

// 第一层函数接收mapStateToProps和mapDispatchToProps
function connect(
  mapStateToProps?: MapStateToPropsParam<TStateProps, TOwnProps, State>,
  mapDispatchToProps?: MapDispatchToPropsParam<TDispatchProps, TOwnProps>,
  mergeProps?: MergeProps<TStateProps, TDispatchProps, TOwnProps, TMergedProps>,
) {
  // 第二层函数是个高阶组件，里面获取context
  // 然后执行mapStateToProps和mapDispatchToProps
  // 再将这个结果组合用户的参数作为最终参数渲染WrappedComponent
  // wrapWithConnect 就是执行 connect(mapStateToProps,mapDispatchToProps) 后的返回值
  // 一个 HOC：接收一个组件作为参数，返回增强后的组件
   const wrapWithConnect  =  <TProps,>(
    WrappedComponent: ComponentType<TProps>,
    ) => {
    // ConnectFuction 可以看作是 HOC 的直接返回值，与 Redux 相关的状态更新逻辑都封装在其中
    function ConnectFunction(props) {
      // 这里是从 props 中提取出 reactReduxForwardedRef 和其他的 wrapperProps，
      // 同时将 props.context 作为一个单独的变量返回。
      // 这样做的目的是为了区分传递给包装组件的实际“数据”属性和控制行为所需的值（如转发的引用、替代上下文实例）。
      const [propsContext, reactReduxForwardedRef, wrapperProps] =
        React.useMemo(() => {
          const { reactReduxForwardedRef, ...wrapperProps } = props
          return [props.context, reactReduxForwardedRef, wrapperProps]
        }, [props])

      // 获取context的值
      const context = useContext(ReactReduxContext);

      const { store } = context;  // 解构出store
      const state = store.getState();   // 拿到state

      // 执行mapStateToProps和mapDispatchToProps
      const stateProps = mapStateToProps(state);
      const dispatchProps = mapDispatchToProps(store.dispatch);

      // 组装最终的props
      const actualChildProps = Object.assign({}, stateProps, dispatchProps, wrapperProps);

      // 渲染WrappedComponent
      return <WrappedComponent {...actualChildProps}></WrappedComponent>
    }

    return ConnectFunction;
  }

   return wrapWithConnect;
}

export default connect;


```

**响应 Redux 变化**

上文 connect 的基本功能代码中并不能响应 Redux 的 state 变化，为此可以利用 store.subscribe
方法注册一个回调函数来响应 state 的变化。在回调函数中，我们需要完成两件事:

- 在 state 变化时，检查最终传递给 WrappedComponent 的 props 是否有发生变化
- 如果有变化，则重新渲染该组件，没有则不做响应

1） 检测参数变化

这里使用 useRef 记录上次的最终传递给组件的 props，使用 useLayoutEffect 在每次dom 更新后立即记录最新的最终 props 值。

为什么不使用 useEffect：

- 避免错过更新：在组件渲染和浏览器绘制之间，如果使用 useEffect，可能会错过 Redux store 的更新（因为 useEffect 是异步执行的）。useLayoutEffect 通过同步执行来确保组件能够及时响应 Redux store 的最新状态。

在服务端还是使用的useEffect。

```TSX
// 记录上次渲染参数
const lastChildProps = useRef();
useLayoutEffect(() => {
  lastChildProps.current = actualChildProps;
}, []);


```

接下来是计算每次 state 变化后新生成的 props,我们将更新逻辑整合在 childPropsSelector 函数中，每次 state 发生变化就执行这个函数。

```TSX
// 通过工厂函数，生成一个处理组件 props 变化的函数：根据最新的state 和 props 计算最终的 props
// childPropsSelector：(nextState: State, nextOwnProps: any) => any
 const childPropsSelector = (nextState,nextOwnProps)=>{
  const stateProps = mapStateToProps(nextState);
  const dispatchProps = mapDispatchToProps(store.dispatch);
  return Object.assign({}, stateProps, dispatchProps, nextOwnProps);
}
```

2） 更新组件

在 React 中可以使用很多种方式来强制更新组件，RR 历史上采用过this.setState({})、useReducer的方式，现在最新版中使用的是 R18 提供的 [useSyncExternalStore](https://react.nodejs.cn/reference/react/useSyncExternalStore),react-redux 并没有直接从 React 中引入这个 API，而是使用的一个[独立的 npm 包](https://github.com/reactwg/react-18/discussions/86)，所以任何支持 hooks 的 React 版本中都可以使用。

只要 actualChildPropsSelector 的返回值发生了变化，React 就会重新渲染组件。

```TSX
let actualChildProps ;

const subscribeForReact = (reactListener)=>{
  const checkForUpdates = ()=>{
      // ...省略其他逻辑
      reactListener()
  }
  store.subscribe(() => {
      checkForUpdates()
  });
  // 第一次运行时就默认调用一遍
   checkForUpdates()
}

const actualChildPropsSelector = (nextState,nextOwnProps)=>{
  // 省略值校验逻辑
  childPropsSelector(nextState,nextOwnProps)
}

actualChildProps = useSyncExternalStore(
    subscribeForReact,
    actualChildPropsSelector,
    getServerState
    ? () => childPropsSelector(getServerState(), wrapperProps)
    : actualChildPropsSelector,
)
```

### 保证更新顺序

上文我们实现的 react-redux 中存在这样一个问题：当多个组件同时依赖一个 state 变量，在这个变量更新时，所有组件的更新回调执行顺序将无法和 React 组件规范的更新顺序保持一致。

在 React 中，遵循`父->子`方向的数据流，当多个组件依赖的公共变量发生变化，需要父级组件更新后，再依次发起子组件的更新。而在我们实现的 react-redux 中，数据流是直接由`Redux->父/子组件`，因此更新的顺序无法得到保证。

#### Subscription 类的实现

在 react-redux 官方实现中，基于 store 封装了一个单独的 Subscription 监听类来保证组件间的更新顺序：

- 由 Subscription 统一处理和 state 变化相关的回调，而不是让 connect() 直接通过 store.subscribe 发起订阅。
- 在 Provider() 组件中，初始化一个 Subscription 实例，该实例将根组件更新回调通过 store.subscribe 直接注册到 store 上。并将该实例以 React.Context 的方式传递给后续组件（contextValue.subscription）
- 在 connect() 会通过 useContext 获取上层组件传递的 subscription 实例（RR 中称为 parentSub）。并基于此再创建一个新的 subscription 实例，在该实例中，会将当前组件的更新回调注册到 parentSub上（通过 parentSub.addNestedSub() 方法。这个新的 subscription 实例将在 Context 中覆盖原有的 parentSub 传递给后续的组件。
- 在 state 发生变化时，首先会触发 Provider() 上的更新回调，执行完成后，再执行 notifyNestedSubs(),通知子组件注册的回调发起调用。

![20241005160439](https://raw.gitmirror.com/wenjingyuer/image_store/master/images/20241005160439.png)

```TSX
export function createSubscription(store: any, parentSub?: Subscription) {
  let unsubscribe: VoidFunc | undefined
  let listeners: ListenerCollection = nullListeners

  // 子组件订阅数量
  let subscriptionsAmount = 0

  // 添加嵌套订阅
  function addNestedSub(listener: () => void) {
    trySubscribe()

    const cleanupListener = listeners.subscribe(listener)

    // 清理嵌套订阅
    let removed = false
    return () => {
      if (!removed) {
        removed = true
        cleanupListener()
        tryUnsubscribe()
      }
    }
  }

  // 通知嵌套订阅
  function notifyNestedSubs() {
    listeners.notify()
  }

  // 当状态改变时的处理函数
  function handleChangeWrapper() {
    if (subscription.onStateChange) {
      subscription.onStateChange()
    }
  }


  // 尝试订阅
  function trySubscribe() {
    subscriptionsAmount++
    if (!unsubscribe) {
      unsubscribe = parentSub
        ? parentSub.addNestedSub(handleChangeWrapper)
        : store.subscribe(handleChangeWrapper)

      listeners = createListenerCollection()
    }
  }

  // 尝试取消订阅
  function tryUnsubscribe() {
    subscriptionsAmount--
    if (unsubscribe && subscriptionsAmount === 0) {
      unsubscribe()
      unsubscribe = undefined
      listeners.clear()
      listeners = nullListeners
    }
  }



  // 订阅对象，包含多个处理函数
  const subscription: Subscription = {
    addNestedSub,
    notifyNestedSubs,
    handleChangeWrapper,
    getListeners: () => listeners,
  }

  return subscription
}

```

Subscription 类实现后，就可以基于此对 Provider 和 connect 做相应的调整了。

#### Provider 的改造

在 Provider 中需要创建 subscription 实例并通过 context 传递。

```TSX
import { ReactReduxContext } from './Context'

function Provider<A extends Action<string> = UnknownAction, S = unknown>({
  store,
  context,
  children,
}: ProviderProps<A, S>) {
  const contextValue = React.useMemo(() => {
    const subscription = createSubscription(store)
    return {
      store,
      subscription,
    }
  }, [store])

  const previousState = React.useMemo(() => store.getState(), [store])

  useLayoutEffect(() => {
    const { subscription } = contextValue
    // 当 state 发生变化时，会调用 onStateChange 函数，进而通知下一层 connect() 发起更新
    subscription.onStateChange = subscription.notifyNestedSubs
    subscription.trySubscribe()

    if (previousState !== store.getState()) {
      subscription.notifyNestedSubs()
    }
    return () => {
      subscription.tryUnsubscribe()
      subscription.onStateChange = undefined
    }
  }, [contextValue, previousState])

  const Context = context || ReactReduxContext

  return <Context.Provider value={contextValue}>{children}</Context.Provider>
}

export default Provider

```

#### connect 的改造

有了 Subscription 类后，connect 中组件更新的回调就需要挂在通过 context 获取的最近的一个父级 subscription 实例上。渲染 WrapperComponent 的时候，也需要用 Context.Provider 包裹，并用创建的新的 subscription 实例覆盖原有 subscription。

以下是 react-redux 中 connect 方法的核心源码以及关键注释。

```TSX
function connect(
  mapStateToProps?: MapStateToPropsParam<TStateProps, TOwnProps, State>,
  mapDispatchToProps?: MapDispatchToPropsParam<TDispatchProps, TOwnProps>,
  mergeProps?: MergeProps<TStateProps, TDispatchProps, TOwnProps, TMergedProps>,
) {
  
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
    const wrappedComponentName =
      WrappedComponent.displayName || WrappedComponent.name || 'Component'

    const displayName = `Connect(${wrappedComponentName})`
    const selectorFactoryOptions = {
      shouldHandleStateChanges,
      displayName,
      wrappedComponentName,
      WrappedComponent,
      // @ts-ignore
      initMapStateToProps,
      initMapDispatchToProps,
      initMergeProps,
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
          const { reactReduxForwardedRef, ...wrapperProps } = props
          return [props.context, reactReduxForwardedRef, wrapperProps]
        }, [props])

      const ContextToUse: ReactReduxContextInstance = React.useMemo(() => {
        let ResultContext = Context
        return ResultContext
      }, [propsContext, Context])


      const contextValue = React.useContext(ContextToUse)
      // 判断 store 是从 props 中传递的还是从 context 中传递的。
      // 如果props 中只是个名为 store 的普通对象，那还是会使用 context 中的 store
      const didStoreComeFromProps =
        Boolean(props.store) &&
        Boolean(props.store!.getState) &&
        Boolean(props.store!.dispatch)
      const didStoreComeFromContext =
        Boolean(contextValue) && Boolean(contextValue!.store)

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
        return defaultSelectorFactory(store.dispatch, selectorFactoryOptions)
      }, [store])

      // subscription：当前组件的订阅实例
      // notifyNestedSubs: 通知直接后代组件的更新
      const [subscription, notifyNestedSubs] = React.useMemo(() => {
        if (!shouldHandleStateChanges) return NO_SUBSCRIPTION_ARRAY
        const subscription = createSubscription(
          store,
          didStoreComeFromProps ? undefined : contextValue!.subscription,
        )
        return [subscription, notifyNestedSubs]
      }, [store, didStoreComeFromProps, contextValue])
      // 传递给后续组件的 context 值
      // 1. 如果 store 是从 props 中传递的，则直接使用本组件接收的上层 contextValue
      // 2. 如果 store 是从 context 中传递的，则需要同当前的 subscription 覆盖原始 contextValue 的 subscription
      const overriddenContextValue = React.useMemo(() => {
        if (didStoreComeFromProps) {
               return contextValue!
        }

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
         if (
            childPropsFromStoreUpdate.current &&
            wrapperProps === lastWrapperProps.current
          ) {
            return childPropsFromStoreUpdate.current
          }
          return childPropsSelector(store.getState(), wrapperProps)
        }
        return selector
      }, [store, wrapperProps])

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


        actualChildProps = useSyncExternalStore(
          subscribeForReact,
          actualChildPropsSelector,
          getServerState
            ? () => childPropsSelector(getServerState(), wrapperProps)
            : actualChildPropsSelector,
        )
      // 这里就视作 useLayoutEffect
      // 清空错误信息和上次渲染的子组件 props
      // 保存这次传递给业务子组件的 props
      useIsomorphicLayoutEffect(() => {
        latestSubscriptionCallbackError.current = undefined
        childPropsFromStoreUpdate.current = undefined
        lastChildProps.current = actualChildProps
      })

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

      // 如果当前的组件订阅了 state 的状态，那么需要用当前组件的 subscription 覆盖 contextValue 的 subscription，
      // 这样能保证后续组件的更新，能在当前组件响应完 state 变化后再触发
      const renderedChild = React.useMemo(() => {
        if (shouldHandleStateChanges) {
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
    const Connect = _Connect 
    Connect.WrappedComponent = WrappedComponent
    Connect.displayName = ConnectFunction.displayName = displayName
    return /*#__PURE__*/ hoistStatics(Connect, WrappedComponent)
  }

  return wrapWithConnect
}
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
  additionalSubscribeListener: () => void,
) {
  // 如果没有订阅store, 直接返回
  if (!shouldHandleStateChanges) return () => {}

  let didUnsubscribe = false
  let lastThrownError: Error | null = null

  // 每次当前组件关联的state更新时, 都会执行这个回调函数
  const checkForUpdates = () => {
    if (didUnsubscribe || !isMounted.current) {
        return
    }

    const latestStoreState = store.getState()

    let newChildProps;
      // 用 state 和 props 计算最新的childProps
      newChildProps = childPropsSelector(
        latestStoreState,
        lastWrapperProps.current,
      )
    // 如果childProps没有变化, 那么直接通知下一层组件发起更新即可
    if (newChildProps === lastChildProps.current) {
      if (!renderIsScheduled.current) {
        notifyNestedSubs()
      }
    } else {
      // 保存最新一次的计算结果
      lastChildProps.current = newChildProps
      childPropsFromStoreUpdate.current = newChildProps
      // 标记组件组件有计划进行一次渲染了
      renderIsScheduled.current = true

      // 调用 React 传入的 reactLisenser 函数，随后便会触发组件的重新渲染
      additionalSubscribeListener()

    }
  }

  // 将订阅更新函数绑定到了其上一层 connect 组件的subscription上（默认情况下）
  subscription.onStateChange = checkForUpdates
  subscription.trySubscribe()

  // 第一次运行时就调用一遍 checkForUpdates 函数
  checkForUpdates()

  // useSyncExternalStore 需要的卸载函数
  const unsubscribeWrapper = () => {
    didUnsubscribe = true
    subscription.tryUnsubscribe()
    subscription.onStateChange = null
  }

  return unsubscribeWrapper
}

export default connect as Connect


```

### Hooks

#### useStore

用于直接获取 Redux 的 store 对象。用法：

```TSX
import React from 'react'
import { useStore } from 'react-redux'

export const ExampleComponent = () => {
  const store = useStore()
  return <div>{store.getState()}</div>
}
```

在 react 源码中采用了工厂模式来实现这个Hooks

```TSX
// 用于创建绑定到指定 context 的 `useReduxContext` hook。这是一个 react-redux 底层 hook,通常开发者不需要直接调用它。
export function createReduxContextHook(context = ReactReduxContext) {
  return function useReduxContext(): ReactReduxContextValue {
    const contextValue = React.useContext(context)
    return contextValue!
  }
}

// 一个用于获取 ReactReduxContext 的 hook，通常开发者不需要直接调用它。
export const useReduxContext =  createReduxContextHook()

// Hooks 工厂，用于创建绑定给定 context 的 `useStore` 钩子。
export function createStoreHook(
  context = ReactReduxContext,
) {
  const useReduxContext =
    context === ReactReduxContext
      ? useDefaultReduxContext
      : // @ts-ignore
        createReduxContextHook(context)
  const useStore = () => {
    const { store } = useReduxContext()
    return store
  }

  Object.assign(useStore, {
    withTypes: () => useStore,
  })

  return useStore as UseStore<Store<StateType, ActionType>>
}

export const useStore =  createStoreHook()

```

#### useSelector

useSelector 用于在组件中访问 Redux 的 state。接受一个选择器函数作为参数，该函数用于从 Redux state 中选择出需要的部分状态。此外，它还可以接受一个可选的相等性比较函数作为第二个参数，用于自定义选择出的状态的比较方式，以决定组件是否需要重新渲染。


```TSX
import React from 'react'
import { useSelector } from 'react-redux'

export const CounterComponent = () => {
  const counter = useSelector(state => state.counter)
  return <div>{counter}</div>
}

```

useSyncExternalStoreWithSelector 是实现 useSelector 的关键，相较于 useSyncExternalStor，useSyncExternalStoreWithSelector 只有在 wrappedSelector 返回的数据子集发生变化时才会触发重新渲染。 参见：[https://github.com/reactwg/react-18/discussions/86](https://github.com/reactwg/react-18/discussions/86)。

```TSX
export function createSelectorHook(
  context = ReactReduxContext,
): UseSelector {
  const useReduxContext =
    context === ReactReduxContext
      ? useDefaultReduxContext
      : createReduxContextHook(context)

  const useSelector = (
    selector: (state: TState) => Selected,
    equalityFnOrOptions = {},
  ): Selected => {
    const { equalityFn = refEquality, devModeChecks = {} } =
      typeof equalityFnOrOptions === 'function'
        ? { equalityFn: equalityFnOrOptions }
        : equalityFnOrOptions

    const {
      store,
      subscription,
      getServerState,
      stabilityCheck,
      identityFunctionCheck,
    } = useReduxContext()

    const firstRun = React.useRef(true)

    const wrappedSelector = React.useCallback<typeof selector>(
      {
        [selector.name](state: TState) {
          const selected = selector(state)
          return selected
        },
      }[selector.name],
      [selector, stabilityCheck, devModeChecks.stabilityCheck],
    )

    const selectedState = useSyncExternalStoreWithSelector(
      subscription.addNestedSub,
      store.getState,
      getServerState || store.getState,
      wrappedSelector,
      equalityFn,
    )

    React.useDebugValue(selectedState)

    return selectedState
  }

  Object.assign(useSelector, {
    withTypes: () => useSelector,
  })

  return useSelector as UseSelector
}
```

#### useDispach

一个用于访问 Redux dispach 函数的 Hook，用法如下：

```TSX
import React, { useCallback } from 'react'
import { useDispatch } from 'react-redux'

export const CounterComponent = ({ value }) => {
  const dispatch = useDispatch()
  const increaseCounter = useCallback(() => dispatch({ type: 'increase-counter' }), [])
  return (
    <div>
      <span>{value}</span>
      <button onClick={increaseCounter}>Increase counter</button>
    </div>
  )
}

```

源码实现：

```TSX
export function createDispatchHook(
  context = ReactReduxContext,
) {
  const useStore =
    context === ReactReduxContext ? useDefaultStore : createStoreHook(context)

  const useDispatch = () => {
    const store = useStore()
    return store.dispatch
  }

  Object.assign(useDispatch, {
    withTypes: () => useDispatch,
  })

  return useDispatch as UseDispatch<Dispatch<ActionType>>
}

export const useDispatch = /*#__PURE__*/ createDispatchHook()

```
