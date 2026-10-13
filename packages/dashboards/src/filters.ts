/**
 * Physical device filters (research R5). They are emitted as hidden dashboard constants so
 * an operator can adjust them on an unusual host without editing queries.
 */
export const DISK_EXCLUDE = "(loop|ram|zram|fd|sr|dm-|md).*";
export const INTERFACE_EXCLUDE =
  "lo|docker.*|br-.*|veth.*|virbr.*|cni.*|flannel.*|cali.*|vxlan.*|tun.*|tap.*|wg.*";

export const DISK_EXCLUDE_VAR = "disk_exclude";
export const INTERFACE_EXCLUDE_VAR = "interface_exclude";
