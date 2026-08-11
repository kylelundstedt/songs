export function waitingWorkerActivationDisposition(): "defer-until-clients-close" {
  return "defer-until-clients-close";
}

export function controllerChangeDisposition(liveRoute: boolean): "defer" | "reload" {
  return liveRoute ? "defer" : "reload";
}

export function deferredControllerDisposition(deferred: boolean, liveRoute: boolean): "wait" | "reload" | "none" {
  if (!deferred) return "none";
  return liveRoute ? "wait" : "reload";
}
