import { Route, Switch } from 'wouter'
import { DebugHotkey, DebugPanel } from './components/DebugPanel'
import { HomeScreen } from './screens/HomeScreen'
import { ProjectScreen } from './screens/ProjectScreen'

export function App() {
  return (
    <>
      <Switch>
        <Route path="/">
          <HomeScreen />
        </Route>
        <Route path="/p/:id">{(params) => <ProjectScreen key={params.id} id={params.id} />}</Route>
        <Route>
          <div className="flex h-full items-center justify-center text-xs text-white/55">Not found</div>
        </Route>
      </Switch>
      <DebugHotkey />
      <DebugPanel />
    </>
  )
}
