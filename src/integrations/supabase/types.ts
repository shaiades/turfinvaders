export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      canvasser_stats: {
        Row: {
          contacts_made: number
          created_at: string
          doors_knocked: number
          id: string
          period: string
          period_start: string
          revenue_generated: number
          sales_closed: number
          user_id: string
        }
        Insert: {
          contacts_made?: number
          created_at?: string
          doors_knocked?: number
          id?: string
          period: string
          period_start: string
          revenue_generated?: number
          sales_closed?: number
          user_id: string
        }
        Update: {
          contacts_made?: number
          created_at?: string
          doors_knocked?: number
          id?: string
          period?: string
          period_start?: string
          revenue_generated?: number
          sales_closed?: number
          user_id?: string
        }
        Relationships: []
      }
      company_settings: {
        Row: {
          company_name: string
          global_visibility: boolean
          id: boolean
          updated_at: string
        }
        Insert: {
          company_name?: string
          global_visibility?: boolean
          id?: boolean
          updated_at?: string
        }
        Update: {
          company_name?: string
          global_visibility?: boolean
          id?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      daily_logs: {
        Row: {
          canvasser_id: string
          confirmed_leads: number
          created_at: string
          demos_sits: number
          doors_knocked: number
          future_leads: number
          id: string
          leads_called_in: number
          log_date: string
          next_days: number
          no_demo: number
          no_shows: number
          notes: string | null
          one_legs: number
          people_talked_to: number
          renters: number
          sales: number
          team_id: string | null
          updated_at: string
        }
        Insert: {
          canvasser_id: string
          confirmed_leads?: number
          created_at?: string
          demos_sits?: number
          doors_knocked?: number
          future_leads?: number
          id?: string
          leads_called_in?: number
          log_date?: string
          next_days?: number
          no_demo?: number
          no_shows?: number
          notes?: string | null
          one_legs?: number
          people_talked_to?: number
          renters?: number
          sales?: number
          team_id?: string | null
          updated_at?: string
        }
        Update: {
          canvasser_id?: string
          confirmed_leads?: number
          created_at?: string
          demos_sits?: number
          doors_knocked?: number
          future_leads?: number
          id?: string
          leads_called_in?: number
          log_date?: string
          next_days?: number
          no_demo?: number
          no_shows?: number
          notes?: string | null
          one_legs?: number
          people_talked_to?: number
          renters?: number
          sales?: number
          team_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_logs_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_events: {
        Row: {
          canvasser_id: string | null
          count: number
          created_at: string
          id: string
          occurred_at: string
          team_id: string
        }
        Insert: {
          canvasser_id?: string | null
          count?: number
          created_at?: string
          id?: string
          occurred_at?: string
          team_id: string
        }
        Update: {
          canvasser_id?: string | null
          count?: number
          created_at?: string
          id?: string
          occurred_at?: string
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_events_canvasser_id_fkey"
            columns: ["canvasser_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_events_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          address: string | null
          canvasser_id: string
          created_at: string
          customer_name: string | null
          deny_reason: string | null
          id: string
          is_sale: boolean
          notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          sale_amount: number | null
          status: Database["public"]["Enums"]["lead_status"]
          team_id: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          canvasser_id: string
          created_at?: string
          customer_name?: string | null
          deny_reason?: string | null
          id?: string
          is_sale?: boolean
          notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sale_amount?: number | null
          status?: Database["public"]["Enums"]["lead_status"]
          team_id?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          canvasser_id?: string
          created_at?: string
          customer_name?: string | null
          deny_reason?: string | null
          id?: string
          is_sale?: boolean
          notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sale_amount?: number | null
          status?: Database["public"]["Enums"]["lead_status"]
          team_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      offices: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string
          id: string
          level: number
          status: Database["public"]["Enums"]["canvasser_status"]
          team_id: string | null
          updated_at: string
          xp: number
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name: string
          id: string
          level?: number
          status?: Database["public"]["Enums"]["canvasser_status"]
          team_id?: string | null
          updated_at?: string
          xp?: number
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          id?: string
          level?: number
          status?: Database["public"]["Enums"]["canvasser_status"]
          team_id?: string | null
          updated_at?: string
          xp?: number
        }
        Relationships: [
          {
            foreignKeyName: "profiles_team_fk"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          captain_id: string | null
          color: string
          created_at: string
          id: string
          name: string
          office_id: string | null
        }
        Insert: {
          captain_id?: string | null
          color?: string
          created_at?: string
          id?: string
          name: string
          office_id?: string | null
        }
        Update: {
          captain_id?: string | null
          color?: string
          created_at?: string
          id?: string
          name?: string
          office_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "teams_office_id_fkey"
            columns: ["office_id"]
            isOneToOne: false
            referencedRelation: "offices"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      evaluate_canvasser_suspension: {
        Args: { _canvasser_id: string }
        Returns: undefined
      }
      global_visibility_on: { Args: never; Returns: boolean }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      my_team_id: { Args: { _user_id: string }; Returns: string }
    }
    Enums: {
      app_role: "owner" | "captain" | "canvasser" | "office_staff"
      canvasser_status: "active" | "suspended" | "inactive"
      lead_status: "pending" | "confirmed" | "denied"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["owner", "captain", "canvasser", "office_staff"],
      canvasser_status: ["active", "suspended", "inactive"],
      lead_status: ["pending", "confirmed", "denied"],
    },
  },
} as const
