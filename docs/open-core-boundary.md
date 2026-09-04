# Open-core boundary

Status: agreed on 2026-09-04. This document says which parts of Domovoi are Apache-2.0, which are
commercial, where each lives, and why. It exists so that the boundary is decided once rather than
re-argued at each new service, and so a contributor can tell without asking whether their change
belongs in the open repository.

## The rule

The local product is open. The operated services are commercial.

Everything a person runs on their own machines is Apache-2.0: the daemon, the protocol, every
client, the local transports, and the contracts those speak. A machine you own, running your code,
under your control, is Domovoi. That has to stay open for the product to be worth adopting, and it
is the half that has to be inspectable for anyone to trust it with their repositories and their
provider credentials.

Everything Domovoi operates on a customer's behalf is commercial: the rendezvous implementation and
operated relay service, accounts and authentication, subscription and entitlement management, the
shared key vault, and team services.

## What that means in practice

Publishing a wire contract does not publish the server that implements it. The protocol defines the
encrypted relay route and the daemon owns a service-neutral outbound connection manager that may
dial any conforming endpoint. Both are Apache-2.0. The official rendezvous is not.

This is a deliberate split rather than an accident of packaging. The open half must remain genuinely
useful on its own: a person on one private network, or on a tailnet, gets a complete product with no
account and no subscription. The commercial half sells reachability, identity, and shared state,
which are the things that only make sense when somebody operates them for you.

## Where the code lives

The open repository is `getdomovoi/domovoi`, public and Apache-2.0. Anything committed there is
published under that licence the moment it lands, which is the whole reason the commercial services
cannot be developed in a subdirectory of it. A second licence covering one folder of an Apache
repository puts the burden on every reader to know which directory is which, and someone eventually
gets that wrong.

Commercial services live in private repositories under the same `getdomovoi` organisation, so
ownership, access control, and billing stay in one place.

They are split by threat surface rather than by licence, because that is the line that costs
something when it is wrong:

- **Relay** stands alone. It is internet-facing, holds many long-lived connections, and is
  deliberately dumb. It has the largest attack surface of anything we run.
- **Accounts, subscription, and entitlements** may share a repository. They are a low-traffic
  control plane, they change together, and they share account and entitlement types.
- **The vault** is treated separately, for the reason below.

Putting the relay and the control plane in one repository would mean a single leaked CI credential
or one bad dependency reaches both, and they have opposite operational profiles.

## The vault constraint

Domovoi's public commitment is that the company cannot read session content. A shared key vault that
holds customer provider credentials in a form we can read contradicts that commitment directly, and
it would be the most attractive target we own.

So the vault stores ciphertext we cannot decrypt, with keys derived on the client. Recovery must not
route plaintext provider credentials through the service. This is a design constraint on the vault,
not a preference about its repository, and it is the constraint that makes the repository question
small.

## Prerequisite before anything splits out

Every commercial service needs `@getdomovoi/protocol`. It is currently a workspace path, so a
private repository cannot build against it without vendoring or a submodule, and both get painful
quickly. Publishing the protocol package is therefore a prerequisite for extracting any commercial
service, not a later tidying step.

## What is not decided here

Pricing, entitlement shape, and whether team services are one product or several. The boundary above
says where those live when they exist; it does not say what they are.
