import {
  baseType,
  CompositeType,
  FieldDefinition,
  InputFieldDefinition,
  InputObjectType,
  InterfaceType,
  isEnumType,
  isInterfaceType,
  isObjectType,
  isUnionType,
  ListType,
  NamedType,
  newNamedType,
  NonNullType,
  NullableType,
  ObjectType,
  Schema,
  Type,
  VariableDefinitions
} from "./definitions";
import { federationBuiltIns } from "./federation";
import { joinIdentity, JoinSpecDefinition, JOIN_VERSIONS } from "./joinSpec";
import { parseSelectionSet } from "./operations";
import { Subgraph, Subgraphs } from "./federation";
import { assert } from "./utils";
import { GraphQLError } from "graphql";

function filteredTypes(supergraph: Schema, joinSpec: JoinSpecDefinition): NamedType[] {
  return [...supergraph.types()].filter(t => !joinSpec.isSpecType(t));
}

export function extractSubgraphsFromSupergraph(supergraph: Schema): Subgraphs {
  const coreFeatures = supergraph.coreFeatures;
  if (!coreFeatures) {
    throw new GraphQLError("Invalid supergraph: must be a core schema");
  }
  const joinFeature = coreFeatures.getByIdentity(joinIdentity);
  if (!joinFeature) {
    throw new GraphQLError("Invalid supergraph: must use the join spec");
  }
  const joinSpec = JOIN_VERSIONS.find(joinFeature.url.version);
  if (!joinSpec) {
    throw new GraphQLError(
      `Invalid supergraph: uses unsupported join spec version ${joinFeature.url.version} (supported versions: ${JOIN_VERSIONS.versions().join(', ')})`);
  }

  // We first collect the subgraphs (creating an empty schema that we'll populate next for each).
  const subgraphs = new Subgraphs();
  const graphDirective = joinSpec.graphDirective(supergraph);
  const graphEnum = joinSpec.graphEnum(supergraph);
  const graphEnumNameToSubgraphName = new Map<string, string>();
  for (const value of graphEnum.values) {
    const graphApplications = value.appliedDirectivesOf(graphDirective);
    if (!graphApplications.length) {
      throw new Error(`Value ${value} of join__Graph enum has no @join__graph directive`);
    }
    const info = graphApplications[0].arguments();
    const subgraph = new Subgraph(info.name, info.url, new Schema(federationBuiltIns), false);
    subgraphs.add(subgraph);
    graphEnumNameToSubgraphName.set(value.name, info.name);
  }
  const typeDirective = joinSpec.typeDirective(supergraph);
  const implementsDirective = joinSpec.implementsDirective(supergraph);

  // Next, we iterate on all types and add it to the proper subgraphs (along with any @key).
  // Note that we first add all types empty and populate the types next. This avoids having to care about the iteration 
  // order if we have fields than depends on other types.
  for (const type of filteredTypes(supergraph, joinSpec)) {
    const typeApplications = type.appliedDirectivesOf(typeDirective);
    if (!typeApplications.length) {
      // Imply the type is in all subgraphs (technically, some subgraphs may not have had this type, but adding it
      // in that case is harmless because it will be unreachable anyway).
      subgraphs.values().map(sg => sg.schema).forEach(schema => schema.addType(newNamedType(type.kind, type.name)));
    } else {
      for (const application of typeApplications) {
        const args = application.arguments();
        const schema = subgraphs.get(graphEnumNameToSubgraphName.get(args.graph)!)!.schema; 
        // We can have more than one type directive for a given subgraph
        let subgraphType = schema.type(type.name);
        if (!subgraphType) {
          subgraphType = schema.addType(newNamedType(type.kind, type.name));
        }
        if (args.key) {
          subgraphType.applyDirective('key', {'fields': args.key});
        }
      }
    }
  }

  const ownerDirective = joinSpec.ownerDirective(supergraph);
  const fieldDirective = joinSpec.fieldDirective(supergraph);
  // We can now populate all those types (with relevant @provides and @requires on fields).
  for (const type of filteredTypes(supergraph, joinSpec)) {
    switch (type.kind) {
      case 'ObjectType':
      case 'InterfaceType':
      case 'InputObjectType':
        const implementsApplications = implementsDirective ? type.appliedDirectivesOf(implementsDirective) : [];
        for (const application of implementsApplications) {
          const args = application.arguments();
          const schema = subgraphs.get(graphEnumNameToSubgraphName.get(args.graph)!)!.schema; 
          (schema.type(type.name)! as (ObjectType | InterfaceType)).addImplementedInterface(args.interface);
        }
        for (const field of type.fields()) {
          const fieldApplications = field.appliedDirectivesOf(fieldDirective);
          if (!fieldApplications.length) {
            // The meaning of having no join__field depends on whether the parent type has a join__owner.
            // If it does, it means the field is only on that owner subgraph. Otherwise, it's in all subgraphs
            // (that have the type).
            const ownerApplications = ownerDirective ? field.appliedDirectivesOf(ownerDirective) : [];
            if (!ownerApplications.length) {
              for (const subgraph of subgraphs) {
                addSubgraphField(field, subgraph);
              }
            } else {
              assert(ownerApplications.length == 1, `Found multiple join__owner directives for field ${field.coordinate}`)
              const subgraph = subgraphs.get(graphEnumNameToSubgraphName.get(ownerApplications[0].arguments().graph)!)!;
              const subgraphField = addSubgraphField(field, subgraph);
              assert(subgraphField, `Found join__owner directive on ${type} but no corresponding join__type`);
            }
          } else {
            for (const application of fieldApplications) {
              const args = application.arguments();
              const subgraph = subgraphs.get(graphEnumNameToSubgraphName.get(args.graph)!)!;
              const subgraphField = addSubgraphField(field, subgraph);
              assert(subgraphField, `Found join__field directive for graph ${subgraph.name} on field ${field.coordinate} but no corresponding join__type on ${type}`);
              if (args.requires) {
                subgraphField.applyDirective('requires', {'fields': args.requires});
              }
              if (args.provides) {
                subgraphField.applyDirective('provides', {'fields': args.requires});
              }
            }
          }
        }
        break;
      case 'EnumType':
        // TODO: it's not guaranteed that every enum value was in every subgraph declaring the enum and we should preserve
        // that info with the join spec. But for now, we add every values to all subgraphs (having the enum)
        for (const subgraph of subgraphs) {
          const subgraphEnum = subgraph.schema.type(type.name);
          if (!subgraphEnum) {
            continue;
          }
          assert(isEnumType(subgraphEnum), `${subgraphEnum} should be an enum but found a ${subgraphEnum.kind}`);
          for (const value of type.values) {
            subgraphEnum.addValue(value.name);
          }
        }
        break;
      case 'UnionType':
        // TODO: Same as for enums. We need to know in which subgraph each member is defined.
        // But for now, we also add every members to all subgraphs (as long as the subgraph has both the union type
        // and the member in question).
        for (const subgraph of subgraphs) {
          const subgraphUnion = subgraph.schema.type(type.name);
          if (!subgraphUnion) {
            continue;
          }
          assert(isUnionType(subgraphUnion), `${subgraphUnion} should be an enum but found a ${subgraphUnion.kind}`);
          for (const memberType of type.types()) {
            const subgraphType = subgraph.schema.type(memberType.name);
            if (subgraphType) {
              subgraphUnion.addType(subgraphType as ObjectType);
            }
          }
        }
        break;
    }
  }

  // Lastly, let's make sure we had @external fields so code doesn't get confused later when it tries to parse one of
  // the @key, @requires or @provides directive field-set
  for (const subgraph of subgraphs) {
    addExternalFields(subgraph, supergraph);
    // We're done for the subgraph, so call validate (which, amongst other things, sets up the _entities query field, which ensures
    // all entities in all subgraphs are reachable from a query and so are properly included in the "query graph" later).
    subgraph.schema.validate();
  }

  return subgraphs;
}

type AnyField = FieldDefinition<ObjectType | InterfaceType> | InputFieldDefinition;

function addSubgraphField(supergraphField: AnyField, subgraph: Subgraph): AnyField | undefined {
  if (supergraphField instanceof FieldDefinition) {
    return addSubgraphObjectOrInterfaceField(supergraphField, subgraph);
  } else {
    return addSubgraphInputField(supergraphField, subgraph);
  }
}

function addSubgraphObjectOrInterfaceField(supergraphField: FieldDefinition<ObjectType | InterfaceType>, subgraph: Subgraph): FieldDefinition<ObjectType | InterfaceType> | undefined {
  const subgraphType = subgraph.schema.type(supergraphField.parent!.name);
  if (subgraphType) {
    const copiedType = copyType(supergraphField.type!, subgraph.schema, subgraph.name);
    const field = (subgraphType as ObjectType | InterfaceType).addField(supergraphField.name, copiedType);
    for (const arg of supergraphField.arguments()) {
      field.addArgument(arg.name, copyType(arg.type!, subgraph.schema, subgraph.name), arg.defaultValue);
    }
    return field;
  } else {
    return undefined;
  }
}

function addSubgraphInputField(supergraphField: InputFieldDefinition, subgraph: Subgraph): InputFieldDefinition | undefined {
  const subgraphType = subgraph.schema.type(supergraphField.parent!.name);
  if (subgraphType) {
    const copiedType = copyType(supergraphField.type!, subgraph.schema, subgraph.name);
    return (subgraphType as InputObjectType).addField(supergraphField.name, copiedType);
  } else {
    return undefined;
  }
}

function copyType(type: Type, subgraph: Schema, subgraphName: string): Type {
  switch (type.kind) {
    case 'ListType':
      return new ListType(copyType(type.ofType, subgraph, subgraphName));
    case 'NonNullType':
      return new NonNullType(copyType(type.ofType, subgraph, subgraphName) as NullableType);
    default:
      const subgraphType = subgraph.type(type.name);
      assert(subgraphType, `Cannot find type ${type.name} in subgraph ${subgraphName}`);
      return subgraphType!;
  }
}

function addExternalFields(subgraph: Subgraph, supergraph: Schema) {
  for (const type of subgraph.schema.types()) {
    if (!isObjectType(type) && !isInterfaceType(type)) {
      continue;
    }

    // First, handle @key
    for (const keyApplication of type.appliedDirectivesOf(federationBuiltIns.keyDirective(subgraph.schema))) {
      addExternalFieldsFromSelection(subgraph, type, keyApplication.arguments().fields, supergraph, false);
    }
    // Then any @requires or @provides on fields
    for (const field of type.fields()) {
      for (const requiresApplication of field.appliedDirectivesOf(federationBuiltIns.requiresDirective(subgraph.schema))) {
        addExternalFieldsFromSelection(subgraph, type, requiresApplication.arguments().fields, supergraph);
      }
      const fieldBaseType = baseType(field.type!);
      for (const providesApplication of field.appliedDirectivesOf(federationBuiltIns.providesDirective(subgraph.schema))) {
        assert(isObjectType(fieldBaseType) || isInterfaceType(fieldBaseType), `Found @provides on field ${field.coordinate} whose type ${field.type!} (${fieldBaseType.kind}) is not an object or interface `); 
        addExternalFieldsFromSelection(subgraph, fieldBaseType, providesApplication.arguments().fields, supergraph);
      }
    }
  }
}

function addExternalFieldsFromSelection(
  subgraph: Subgraph, 
  parentType: ObjectType | InterfaceType,
  selection: string,
  supergraph: Schema,
  markExternal: boolean = true
) {
  let accessor = function (type: CompositeType, fieldName: string): FieldDefinition<any> {
    const field = type.field(fieldName);
    if (field) {
      return field;
    }
    assert(!isUnionType(type), `Shouldn't select field ${fieldName} from union type ${type}`);

    // If the field has not been added, it is external and needs to be added as such
    const supergraphType = supergraph.type(type.name) as ObjectType | InterfaceType;
    const supergraphField = supergraphType.field(fieldName);
    assert(supergraphField, `No field name ${fieldName} found on type ${type.name} in the supergraph`);
    // We're know the parent type of the field exists in the subgraph (it's `type`), so we're guaranteed a field is created.
    const created = addSubgraphObjectOrInterfaceField(supergraphField, subgraph)!;
    if (markExternal) {
      created.applyDirective(federationBuiltIns.externalDirective(subgraph.schema));
    }
    return created;
  };
  parseSelectionSet(parentType, selection, new VariableDefinitions(), undefined, accessor);
}
